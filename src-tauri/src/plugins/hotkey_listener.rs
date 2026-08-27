use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{
    plugin::{Builder, TauriPlugin},
    AppHandle, Emitter, Manager, Runtime,
};

// ========== Public Types ==========

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum ModifierFlag {
    Command,
    Control,
    Option,
    Shift,
    Fn,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum TriggerKey {
    // macOS keys (keycode)
    Fn,
    Option,
    RightOption,
    Command,
    // Windows keys (VK code)
    RightAlt,
    LeftAlt,
    // Cross-platform
    Control,
    RightControl,
    Shift,
    // User-defined key (platform-specific keycode)
    Custom { keycode: u16 },
    // Modifier(s) + primary key
    Combo {
        modifiers: Vec<ModifierFlag>,
        keycode: u16,
    },
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum TriggerMode {
    Hold,
    Toggle,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
enum HotkeyAction {
    Start,
    Stop,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct HotkeyEventPayload {
    mode: TriggerMode,
    action: HotkeyAction,
}

// ========== Shared State ==========

struct RecordingState {
    is_active: bool,
    accumulated_modifiers: HashSet<ModifierFlag>,
    last_modifier_keycode: Option<u16>,
}

impl RecordingState {
    fn new() -> Self {
        Self {
            is_active: false,
            accumulated_modifiers: HashSet::new(),
            last_modifier_keycode: None,
        }
    }

    fn reset(&mut self) {
        self.is_active = false;
        self.accumulated_modifiers.clear();
        self.last_modifier_keycode = None;
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct RecordingCapturedPayload {
    keycode: u16,
    modifiers: Vec<ModifierFlag>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct RecordingRejectedPayload {
    reason: String,
}

struct HotkeySharedState {
    /// Recording hotkey. This key ONLY starts/stops recording.
    trigger_key: TriggerKey,
    trigger_mode: TriggerMode,
    /// Dedicated prompt-mode hotkey. None means unassigned (default).
    mode_toggle_key: Option<TriggerKey>,
    active_modifiers: HashSet<ModifierFlag>,
    recording: RecordingState,
}

pub struct HotkeyListenerState {
    shared: Arc<Mutex<HotkeySharedState>>,
    is_pressed: Arc<AtomicBool>,
    is_toggled_on: Arc<AtomicBool>,
    mode_toggle_pressed: Arc<AtomicBool>,
    #[cfg(target_os = "macos")]
    run_loop_ref: Arc<Mutex<Option<core_foundation::runloop::CFRunLoop>>>,
}

impl Clone for HotkeyListenerState {
    fn clone(&self) -> Self {
        Self {
            shared: self.shared.clone(),
            is_pressed: self.is_pressed.clone(),
            is_toggled_on: self.is_toggled_on.clone(),
            mode_toggle_pressed: self.mode_toggle_pressed.clone(),
            #[cfg(target_os = "macos")]
            run_loop_ref: self.run_loop_ref.clone(),
        }
    }
}

impl HotkeyListenerState {
    pub fn reset_key_states(&self) {
        self.is_pressed.store(false, Ordering::SeqCst);
        self.is_toggled_on.store(false, Ordering::SeqCst);
        self.mode_toggle_pressed.store(false, Ordering::SeqCst);
        if let Ok(mut shared) = self.shared.lock() {
            shared.active_modifiers.clear();
        }
    }

    pub fn update_config(&self, key: TriggerKey, mode: TriggerMode) {
        if let Ok(mut shared) = self.shared.lock() {
            shared.trigger_key = key;
            shared.trigger_mode = mode;
            shared.active_modifiers.clear();
        }
        self.is_pressed.store(false, Ordering::SeqCst);
        self.is_toggled_on.store(false, Ordering::SeqCst);
    }

    pub fn update_mode_toggle_config(&self, key: Option<TriggerKey>) {
        if let Ok(mut shared) = self.shared.lock() {
            shared.mode_toggle_key = key;
            shared.active_modifiers.clear();
        }
        self.mode_toggle_pressed.store(false, Ordering::SeqCst);
    }

    #[cfg(target_os = "macos")]
    pub fn shutdown(&self) {
        stop_existing_event_tap(&self.run_loop_ref);
    }

    #[cfg(not(target_os = "macos"))]
    pub fn shutdown(&self) {}
}

// ========== Matching ==========

fn matches_combo_trigger(
    keycode: u16,
    combo_modifiers: &[ModifierFlag],
    combo_keycode: u16,
    active_mods: &HashSet<ModifierFlag>,
) -> bool {
    if combo_modifiers.is_empty() || keycode != combo_keycode {
        return false;
    }
    #[cfg(target_os = "macos")]
    if combo_keycode == 53 {
        return false;
    }
    #[cfg(target_os = "windows")]
    if combo_keycode == 0x1B {
        return false;
    }
    combo_modifiers.len() == active_mods.len()
        && combo_modifiers.iter().all(|m| active_mods.contains(m))
}

fn handle_recording_key_event<R: Runtime>(
    app_handle: &AppHandle<R>,
    pressed: bool,
    state: &HotkeyListenerState,
    mode: &TriggerMode,
) {
    match mode {
        TriggerMode::Hold => {
            if pressed {
                if !state.is_pressed.swap(true, Ordering::SeqCst) {
                    let _ = app_handle.emit(
                        "hotkey:pressed",
                        HotkeyEventPayload {
                            mode: TriggerMode::Hold,
                            action: HotkeyAction::Start,
                        },
                    );
                }
            } else if state.is_pressed.swap(false, Ordering::SeqCst) {
                let _ = app_handle.emit(
                    "hotkey:released",
                    HotkeyEventPayload {
                        mode: TriggerMode::Hold,
                        action: HotkeyAction::Stop,
                    },
                );
            }
        }
        TriggerMode::Toggle => {
            if pressed && !state.is_pressed.swap(true, Ordering::SeqCst) {
                // Toggle mode reacts on key release so holding the recording key has
                // no hidden secondary action.
            } else if !pressed && state.is_pressed.swap(false, Ordering::SeqCst) {
                let was_on = state.is_toggled_on.fetch_xor(true, Ordering::SeqCst);
                let action = if was_on {
                    HotkeyAction::Stop
                } else {
                    HotkeyAction::Start
                };
                let _ = app_handle.emit(
                    "hotkey:toggled",
                    HotkeyEventPayload {
                        mode: TriggerMode::Toggle,
                        action,
                    },
                );
            }
        }
    }
}

fn handle_mode_toggle_key_event<R: Runtime>(
    app_handle: &AppHandle<R>,
    pressed: bool,
    state: &HotkeyListenerState,
) {
    if pressed {
        if !state.mode_toggle_pressed.swap(true, Ordering::SeqCst) {
            println!("[hotkey-listener] dedicated mode-toggle hotkey pressed");
            let _ = app_handle.emit("hotkey:mode-toggle-dedicated", ());
        }
    } else {
        state.mode_toggle_pressed.store(false, Ordering::SeqCst);
    }
}

// ========== macOS ==========

#[cfg(target_os = "macos")]
use core_foundation::runloop::{kCFRunLoopCommonModes, CFRunLoop};
#[cfg(target_os = "macos")]
use core_graphics::event::{
    CGEventFlags, CGEventTap, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement,
    CGEventType,
};

#[cfg(target_os = "macos")]
mod macos_keycodes {
    pub const FN: u16 = 63;
    pub const OPTION_L: u16 = 58;
    pub const OPTION_R: u16 = 61;
    pub const CONTROL_L: u16 = 59;
    pub const CONTROL_R: u16 = 62;
    pub const COMMAND_L: u16 = 55;
    pub const COMMAND_R: u16 = 54;
    pub const SHIFT_L: u16 = 56;
    pub const SHIFT_R: u16 = 60;
    pub const ESCAPE: u16 = 53;
}

#[cfg(target_os = "macos")]
fn check_accessibility_permission() -> bool {
    extern "C" {
        fn AXIsProcessTrusted() -> bool;
    }
    let trusted = unsafe { AXIsProcessTrusted() };
    println!("[hotkey-listener] AXIsProcessTrusted = {trusted}");
    trusted
}

#[tauri::command]
pub fn check_accessibility_permission_command() -> bool {
    #[cfg(target_os = "macos")]
    {
        check_accessibility_permission()
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

#[tauri::command]
pub fn open_accessibility_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
            .spawn()
            .map_err(|err| err.to_string())?;
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn prompt_accessibility_permission() {
    use core_foundation::base::TCFType;
    use core_foundation::boolean::CFBoolean;
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::string::CFString;
    use std::ffi::c_void;

    extern "C" {
        fn AXIsProcessTrustedWithOptions(options: *const c_void) -> bool;
    }

    let key = CFString::new("AXTrustedCheckOptionPrompt");
    let value = CFBoolean::true_value();
    let options = CFDictionary::from_CFType_pairs(&[(key, value)]);
    unsafe {
        AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef() as *const c_void);
    }
}

#[cfg(target_os = "macos")]
fn matches_trigger_key_macos(keycode: u16, trigger_key: &TriggerKey) -> bool {
    match trigger_key {
        TriggerKey::Fn => keycode == macos_keycodes::FN,
        TriggerKey::Option => keycode == macos_keycodes::OPTION_L,
        TriggerKey::RightOption => keycode == macos_keycodes::OPTION_R,
        TriggerKey::Control => keycode == macos_keycodes::CONTROL_L,
        TriggerKey::RightControl => keycode == macos_keycodes::CONTROL_R,
        TriggerKey::Command => keycode == macos_keycodes::COMMAND_L,
        TriggerKey::Shift => keycode == macos_keycodes::SHIFT_L,
        TriggerKey::Custom { keycode: custom_kc } => keycode == *custom_kc,
        TriggerKey::Combo { .. } => false,
        _ => false,
    }
}

#[cfg(target_os = "macos")]
fn is_modifier_pressed(flags: CGEventFlags, trigger_key: &TriggerKey) -> Option<bool> {
    match trigger_key {
        TriggerKey::Fn => Some(flags.contains(CGEventFlags::CGEventFlagSecondaryFn)),
        TriggerKey::Option | TriggerKey::RightOption => {
            Some(flags.contains(CGEventFlags::CGEventFlagAlternate))
        }
        TriggerKey::Control | TriggerKey::RightControl => {
            Some(flags.contains(CGEventFlags::CGEventFlagControl))
        }
        TriggerKey::Command => Some(flags.contains(CGEventFlags::CGEventFlagCommand)),
        TriggerKey::Shift => Some(flags.contains(CGEventFlags::CGEventFlagShift)),
        TriggerKey::Custom { keycode } => match *keycode {
            macos_keycodes::OPTION_L | macos_keycodes::OPTION_R => {
                Some(flags.contains(CGEventFlags::CGEventFlagAlternate))
            }
            macos_keycodes::CONTROL_L | macos_keycodes::CONTROL_R => {
                Some(flags.contains(CGEventFlags::CGEventFlagControl))
            }
            macos_keycodes::COMMAND_L | macos_keycodes::COMMAND_R => {
                Some(flags.contains(CGEventFlags::CGEventFlagCommand))
            }
            macos_keycodes::SHIFT_L | macos_keycodes::SHIFT_R => {
                Some(flags.contains(CGEventFlags::CGEventFlagShift))
            }
            macos_keycodes::FN => Some(flags.contains(CGEventFlags::CGEventFlagSecondaryFn)),
            _ => None,
        },
        _ => None,
    }
}

#[cfg(target_os = "macos")]
fn extract_active_modifiers_macos(flags: CGEventFlags) -> HashSet<ModifierFlag> {
    let mut mods = HashSet::new();
    if flags.contains(CGEventFlags::CGEventFlagCommand) {
        mods.insert(ModifierFlag::Command);
    }
    if flags.contains(CGEventFlags::CGEventFlagControl) {
        mods.insert(ModifierFlag::Control);
    }
    if flags.contains(CGEventFlags::CGEventFlagAlternate) {
        mods.insert(ModifierFlag::Option);
    }
    if flags.contains(CGEventFlags::CGEventFlagShift) {
        mods.insert(ModifierFlag::Shift);
    }
    if flags.contains(CGEventFlags::CGEventFlagSecondaryFn) {
        mods.insert(ModifierFlag::Fn);
    }
    mods
}

#[cfg(target_os = "macos")]
fn is_modifier_keycode_macos(keycode: u16) -> bool {
    matches!(
        keycode,
        macos_keycodes::COMMAND_L
            | macos_keycodes::COMMAND_R
            | macos_keycodes::SHIFT_L
            | macos_keycodes::SHIFT_R
            | macos_keycodes::CONTROL_L
            | macos_keycodes::CONTROL_R
            | macos_keycodes::OPTION_L
            | macos_keycodes::OPTION_R
            | macos_keycodes::FN
    )
}

#[cfg(target_os = "macos")]
fn handle_recording_capture_event_macos<R: Runtime>(
    app_handle: &AppHandle<R>,
    event_type: CGEventType,
    keycode: u16,
    flags: CGEventFlags,
    state: &HotkeyListenerState,
) {
    match event_type {
        CGEventType::FlagsChanged => {
            if keycode == macos_keycodes::FN {
                let mut shared = match state.shared.lock() {
                    Ok(g) => g,
                    Err(_) => return,
                };
                let tracked = shared.recording.last_modifier_keycode == Some(macos_keycodes::FN)
                    || shared.recording.accumulated_modifiers.contains(&ModifierFlag::Fn);
                if !tracked {
                    shared.recording.accumulated_modifiers.insert(ModifierFlag::Fn);
                    shared.recording.last_modifier_keycode = Some(macos_keycodes::FN);
                } else {
                    shared.recording.reset();
                    drop(shared);
                    let _ = app_handle.emit(
                        "hotkey:recording-captured",
                        RecordingCapturedPayload {
                            keycode: macos_keycodes::FN,
                            modifiers: vec![],
                        },
                    );
                }
                return;
            }

            let mut current_mods = extract_active_modifiers_macos(flags);
            current_mods.remove(&ModifierFlag::Fn);
            let mut shared = match state.shared.lock() {
                Ok(g) => g,
                Err(_) => return,
            };
            if !current_mods.is_empty() {
                shared.recording.accumulated_modifiers = current_mods;
                if is_modifier_keycode_macos(keycode) {
                    shared.recording.last_modifier_keycode = Some(keycode);
                }
            } else if let Some(last_kc) = shared.recording.last_modifier_keycode {
                shared.recording.reset();
                drop(shared);
                let _ = app_handle.emit(
                    "hotkey:recording-captured",
                    RecordingCapturedPayload {
                        keycode: last_kc,
                        modifiers: vec![],
                    },
                );
            }
        }
        CGEventType::KeyDown => {
            let mut shared = match state.shared.lock() {
                Ok(g) => g,
                Err(_) => return,
            };
            if keycode == macos_keycodes::ESCAPE {
                shared.recording.reset();
                drop(shared);
                let _ = app_handle.emit(
                    "hotkey:recording-rejected",
                    RecordingRejectedPayload {
                        reason: "esc_reserved".to_string(),
                    },
                );
                return;
            }
            let mods = shared.recording.accumulated_modifiers.iter().cloned().collect();
            shared.recording.reset();
            drop(shared);
            let _ = app_handle.emit(
                "hotkey:recording-captured",
                RecordingCapturedPayload {
                    keycode,
                    modifiers: mods,
                },
            );
        }
        _ => {}
    }
}

#[cfg(target_os = "macos")]
fn process_trigger_macos<R: Runtime>(
    app_handle: &AppHandle<R>,
    event_type: CGEventType,
    keycode: u16,
    flags: CGEventFlags,
    trigger: &TriggerKey,
    active_mods: &HashSet<ModifierFlag>,
    pressed_state: &AtomicBool,
    on_event: impl Fn(bool),
) -> bool {
    if let TriggerKey::Combo {
        modifiers,
        keycode: combo_kc,
    } = trigger
    {
        match event_type {
            CGEventType::KeyDown if keycode == *combo_kc => {
                if matches_combo_trigger(keycode, modifiers, *combo_kc, active_mods) {
                    on_event(true);
                }
                return true;
            }
            CGEventType::KeyUp if keycode == *combo_kc => {
                on_event(false);
                return true;
            }
            CGEventType::FlagsChanged if pressed_state.load(Ordering::SeqCst) => {
                if !modifiers.iter().all(|m| active_mods.contains(m)) {
                    on_event(false);
                }
                return true;
            }
            _ => return false,
        }
    }

    match event_type {
        CGEventType::FlagsChanged => {
            if matches_trigger_key_macos(keycode, trigger) {
                if let Some(pressed) = is_modifier_pressed(flags, trigger) {
                    on_event(pressed);
                    return true;
                }
            }
        }
        CGEventType::KeyDown => {
            if matches_trigger_key_macos(keycode, trigger) {
                on_event(true);
                return true;
            }
        }
        CGEventType::KeyUp => {
            if matches_trigger_key_macos(keycode, trigger) {
                on_event(false);
                return true;
            }
        }
        _ => {}
    }
    let _ = app_handle;
    false
}

#[cfg(target_os = "macos")]
fn start_event_tap<R: Runtime>(app_handle: AppHandle<R>, state: HotkeyListenerState) {
    let run_loop_ref = state.run_loop_ref.clone();
    std::thread::spawn(move || {
        let app_handle_error = app_handle.clone();
        let tap_result = CGEventTap::new(
            CGEventTapLocation::Session,
            CGEventTapPlacement::HeadInsertEventTap,
            CGEventTapOptions::ListenOnly,
            vec![
                CGEventType::FlagsChanged,
                CGEventType::KeyDown,
                CGEventType::KeyUp,
            ],
            move |_proxy, event_type, event| {
                let keycode = event.get_integer_value_field(
                    core_graphics::event::EventField::KEYBOARD_EVENT_KEYCODE,
                ) as u16;
                let flags = event.get_flags();

                let is_recording_capture = state
                    .shared
                    .lock()
                    .map(|s| s.recording.is_active)
                    .unwrap_or(false);
                if is_recording_capture {
                    handle_recording_capture_event_macos(
                        &app_handle,
                        event_type,
                        keycode,
                        flags,
                        &state,
                    );
                    return None;
                }

                if event_type == CGEventType::KeyDown && keycode == macos_keycodes::ESCAPE {
                    let _ = app_handle.emit("escape:pressed", ());
                    return None;
                }

                let (recording_trigger, mode, mode_toggle_key, active_mods) = {
                    let mut shared = match state.shared.lock() {
                        Ok(g) => g,
                        Err(_) => return None,
                    };
                    if event_type == CGEventType::FlagsChanged {
                        shared.active_modifiers = extract_active_modifiers_macos(flags);
                    }
                    (
                        shared.trigger_key.clone(),
                        shared.trigger_mode.clone(),
                        shared.mode_toggle_key.clone(),
                        shared.active_modifiers.clone(),
                    )
                };

                // Recording hotkey always takes precedence when the two are configured
                // identically. This prevents a recording key from ever switching modes.
                let recording_matched = process_trigger_macos(
                    &app_handle,
                    event_type,
                    keycode,
                    flags,
                    &recording_trigger,
                    &active_mods,
                    &state.is_pressed,
                    |pressed| handle_recording_key_event(&app_handle, pressed, &state, &mode),
                );

                if !recording_matched {
                    if let Some(mode_key) = mode_toggle_key {
                        process_trigger_macos(
                            &app_handle,
                            event_type,
                            keycode,
                            flags,
                            &mode_key,
                            &active_mods,
                            &state.mode_toggle_pressed,
                            |pressed| handle_mode_toggle_key_event(&app_handle, pressed, &state),
                        );
                    }
                }

                None
            },
        );

        match tap_result {
            Ok(tap) => unsafe {
                let loop_source = tap
                    .mach_port
                    .create_runloop_source(0)
                    .expect("Failed to create runloop source");
                let current_run_loop = CFRunLoop::get_current();
                current_run_loop.add_source(&loop_source, kCFRunLoopCommonModes);
                tap.enable();
                if let Ok(mut guard) = run_loop_ref.lock() {
                    *guard = Some(current_run_loop);
                }
                println!("[hotkey-listener] RunLoop started");
                CFRunLoop::run_current();
                if let Ok(mut guard) = run_loop_ref.lock() {
                    *guard = None;
                }
            },
            Err(()) => {
                let _ = app_handle_error.emit(
                    "hotkey:error",
                    serde_json::json!({
                        "error": "accessibility_permission",
                        "message": "CGEventTap creation failed. Grant Accessibility permission."
                    }),
                );
            }
        }
    });
}

#[cfg(target_os = "macos")]
fn stop_existing_event_tap(run_loop_ref: &Arc<Mutex<Option<core_foundation::runloop::CFRunLoop>>>) {
    if let Ok(guard) = run_loop_ref.lock() {
        if let Some(ref rl) = *guard {
            rl.stop();
        }
    }
}

// ========== Commands used by existing app invoke handler ==========

#[tauri::command]
pub fn reset_hotkey_state(state: tauri::State<'_, HotkeyListenerState>) {
    state.reset_key_states();
}

#[tauri::command]
pub fn start_hotkey_recording(state: tauri::State<'_, HotkeyListenerState>) {
    if let Ok(mut shared) = state.shared.lock() {
        shared.recording.reset();
        shared.recording.is_active = true;
    }
    state.is_pressed.store(false, Ordering::SeqCst);
    state.mode_toggle_pressed.store(false, Ordering::SeqCst);
}

#[tauri::command]
pub fn cancel_hotkey_recording(state: tauri::State<'_, HotkeyListenerState>) {
    if let Ok(mut shared) = state.shared.lock() {
        shared.recording.reset();
    }
}

#[tauri::command]
pub fn reinitialize_hotkey_listener<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        if !check_accessibility_permission() {
            return Err("Accessibility permission not granted".to_string());
        }
        let state = app.state::<HotkeyListenerState>();
        stop_existing_event_tap(&state.run_loop_ref);
        std::thread::sleep(std::time::Duration::from_millis(200));
        state.reset_key_states();
        let hook_state = state.inner().clone();
        start_event_tap(app, hook_state);
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = &app;
        Ok(())
    }
}

// ========== Windows ==========

#[cfg(target_os = "windows")]
mod windows_hook {
    use super::*;
    use std::sync::OnceLock;

    const VK_LSHIFT: u32 = 0xA0;
    const VK_LCONTROL: u32 = 0xA2;
    const VK_RCONTROL: u32 = 0xA3;
    const VK_LMENU: u32 = 0xA4;
    const VK_RMENU: u32 = 0xA5;
    const VK_ESCAPE: u32 = 0x1B;
    const VK_F23: u32 = 0x86;
    const VK_LWIN: u32 = 0x5B;
    const VK_RWIN: u32 = 0x5C;

    type KeyHandler = Box<dyn Fn(bool, &TriggerMode) + Send + Sync>;

    struct HookContext {
        shared: Arc<Mutex<HotkeySharedState>>,
        is_pressed: Arc<AtomicBool>,
        mode_toggle_pressed: Arc<AtomicBool>,
        key_handler: KeyHandler,
        mode_toggle_handler: Box<dyn Fn(bool) + Send + Sync>,
        escape_handler: Box<dyn Fn() + Send + Sync>,
        recording_captured_handler: Box<dyn Fn(RecordingCapturedPayload) + Send + Sync>,
        recording_rejected_handler: Box<dyn Fn(RecordingRejectedPayload) + Send + Sync>,
    }

    static CONTEXT: OnceLock<HookContext> = OnceLock::new();

    fn is_modifier_vk(vk: u32) -> bool {
        matches!(
            vk,
            VK_LSHIFT | 0xA1 | VK_LCONTROL | VK_RCONTROL | VK_LMENU | VK_RMENU | VK_LWIN | VK_RWIN
        )
    }

    unsafe fn is_vk_pressed(vk: i32) -> bool {
        use windows::Win32::UI::Input::KeyboardAndMouse::GetKeyState;
        (GetKeyState(vk) & (0x8000u16 as i16)) != 0
    }

    unsafe fn get_active_modifiers_windows() -> HashSet<ModifierFlag> {
        let mut mods = HashSet::new();
        if is_vk_pressed(VK_LWIN as i32) || is_vk_pressed(VK_RWIN as i32) {
            mods.insert(ModifierFlag::Command);
        }
        if is_vk_pressed(VK_LCONTROL as i32) || is_vk_pressed(VK_RCONTROL as i32) {
            mods.insert(ModifierFlag::Control);
        }
        if is_vk_pressed(VK_LMENU as i32) || is_vk_pressed(VK_RMENU as i32) {
            mods.insert(ModifierFlag::Option);
        }
        if is_vk_pressed(VK_LSHIFT as i32) || is_vk_pressed(0xA1) {
            mods.insert(ModifierFlag::Shift);
        }
        mods
    }

    fn matches_single_windows(vk: u32, key: &TriggerKey) -> bool {
        match key {
            TriggerKey::RightAlt => vk == VK_RMENU,
            TriggerKey::LeftAlt => vk == VK_LMENU,
            TriggerKey::Control => vk == VK_LCONTROL,
            TriggerKey::RightControl => vk == VK_RCONTROL,
            TriggerKey::Shift => vk == VK_LSHIFT,
            TriggerKey::Custom { keycode } => vk == *keycode as u32,
            _ => false,
        }
    }

    fn trigger_matches_windows(
        vk: u32,
        is_key_down: bool,
        key: &TriggerKey,
        active_mods: &HashSet<ModifierFlag>,
        pressed_state: &AtomicBool,
    ) -> Option<bool> {
        if let TriggerKey::Combo {
            modifiers,
            keycode,
        } = key
        {
            if vk == *keycode as u32 {
                if is_key_down {
                    if matches_combo_trigger(*keycode, modifiers, *keycode, active_mods) {
                        return Some(true);
                    }
                } else {
                    return Some(false);
                }
            } else if !is_key_down && pressed_state.load(Ordering::SeqCst) {
                if !modifiers.iter().all(|m| active_mods.contains(m)) {
                    return Some(false);
                }
            }
            return None;
        }
        matches_single_windows(vk, key).then_some(is_key_down)
    }

    fn handle_recording_capture_windows(ctx: &HookContext, vk: u16, is_key_down: bool) {
        if is_key_down {
            if vk as u32 == VK_ESCAPE {
                if let Ok(mut shared) = ctx.shared.try_lock() {
                    shared.recording.reset();
                }
                (ctx.recording_rejected_handler)(RecordingRejectedPayload {
                    reason: "esc_reserved".to_string(),
                });
                return;
            }
            if is_modifier_vk(vk as u32) {
                if let Ok(mut shared) = ctx.shared.try_lock() {
                    shared.recording.accumulated_modifiers = unsafe { get_active_modifiers_windows() };
                    shared.recording.last_modifier_keycode = Some(vk);
                }
            } else {
                let mods = if let Ok(mut shared) = ctx.shared.try_lock() {
                    let mods = shared.recording.accumulated_modifiers.iter().cloned().collect();
                    shared.recording.reset();
                    mods
                } else {
                    vec![]
                };
                (ctx.recording_captured_handler)(RecordingCapturedPayload {
                    keycode: vk,
                    modifiers: mods,
                });
            }
        } else if is_modifier_vk(vk as u32) {
            let all_released = unsafe { get_active_modifiers_windows().is_empty() };
            if all_released {
                if let Ok(mut shared) = ctx.shared.try_lock() {
                    if let Some(last_kc) = shared.recording.last_modifier_keycode.take() {
                        shared.recording.reset();
                        drop(shared);
                        (ctx.recording_captured_handler)(RecordingCapturedPayload {
                            keycode: last_kc,
                            modifiers: vec![],
                        });
                    }
                }
            }
        }
    }

    pub fn install<R: Runtime>(app_handle: AppHandle<R>, state: HotkeyListenerState) {
        let app_handle_error = app_handle.clone();
        let app_handle_escape = app_handle.clone();
        let app_handle_rec_captured = app_handle.clone();
        let app_handle_rec_rejected = app_handle.clone();
        let app_handle_mode = app_handle.clone();
        CONTEXT
            .set(HookContext {
                shared: state.shared.clone(),
                is_pressed: state.is_pressed.clone(),
                mode_toggle_pressed: state.mode_toggle_pressed.clone(),
                key_handler: Box::new(move |pressed, mode| {
                    handle_recording_key_event(&app_handle, pressed, &state, mode);
                }),
                mode_toggle_handler: Box::new(move |pressed| {
                    if pressed {
                        let _ = app_handle_mode.emit("hotkey:mode-toggle-dedicated", ());
                    }
                }),
                escape_handler: Box::new(move || {
                    let _ = app_handle_escape.emit("escape:pressed", ());
                }),
                recording_captured_handler: Box::new(move |payload| {
                    let _ = app_handle_rec_captured.emit("hotkey:recording-captured", payload);
                }),
                recording_rejected_handler: Box::new(move |payload| {
                    let _ = app_handle_rec_rejected.emit("hotkey:recording-rejected", payload);
                }),
            })
            .ok();

        std::thread::spawn(move || unsafe {
            use windows::Win32::UI::WindowsAndMessaging::*;
            match SetWindowsHookExW(WH_KEYBOARD_LL, Some(hook_proc), None, 0) {
                Ok(hook) => {
                    let mut msg = MSG::default();
                    while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                        let _ = TranslateMessage(&msg);
                        DispatchMessageW(&msg);
                    }
                    let _ = UnhookWindowsHookEx(hook);
                }
                Err(e) => {
                    let _ = app_handle_error.emit(
                        "hotkey:error",
                        serde_json::json!({
                            "error": "hook_install_failed",
                            "message": format!("Failed to install keyboard hook: {}", e)
                        }),
                    );
                }
            }
        });
    }

    unsafe extern "system" fn hook_proc(
        n_code: i32,
        w_param: windows::Win32::Foundation::WPARAM,
        l_param: windows::Win32::Foundation::LPARAM,
    ) -> windows::Win32::Foundation::LRESULT {
        use windows::Win32::UI::WindowsAndMessaging::*;

        if n_code >= 0 {
            if let Some(ctx) = CONTEXT.get() {
                let kbd = *(l_param.0 as *const KBDLLHOOKSTRUCT);
                if kbd.vkCode == VK_F23 {
                    return CallNextHookEx(None, n_code, w_param, l_param);
                }
                let w = w_param.0 as u32;
                let is_key_down = w == WM_KEYDOWN || w == WM_SYSKEYDOWN;
                let is_key_up = w == WM_KEYUP || w == WM_SYSKEYUP;
                if is_key_down || is_key_up {
                    let is_recording_capture = ctx
                        .shared
                        .try_lock()
                        .map(|s| s.recording.is_active)
                        .unwrap_or(false);
                    if is_recording_capture {
                        handle_recording_capture_windows(ctx, kbd.vkCode as u16, is_key_down);
                        return CallNextHookEx(None, n_code, w_param, l_param);
                    }

                    if kbd.vkCode == VK_ESCAPE && is_key_down {
                        (ctx.escape_handler)();
                        return CallNextHookEx(None, n_code, w_param, l_param);
                    }

                    let (recording_trigger, mode, mode_toggle_key, active_mods) =
                        match ctx.shared.try_lock() {
                            Ok(mut shared) => {
                                shared.active_modifiers = get_active_modifiers_windows();
                                (
                                    shared.trigger_key.clone(),
                                    shared.trigger_mode.clone(),
                                    shared.mode_toggle_key.clone(),
                                    shared.active_modifiers.clone(),
                                )
                            }
                            Err(_) => return CallNextHookEx(None, n_code, w_param, l_param),
                        };

                    if let Some(pressed) = trigger_matches_windows(
                        kbd.vkCode,
                        is_key_down,
                        &recording_trigger,
                        &active_mods,
                        &ctx.is_pressed,
                    ) {
                        (ctx.key_handler)(pressed, &mode);
                    } else if let Some(mode_key) = mode_toggle_key {
                        if let Some(pressed) = trigger_matches_windows(
                            kbd.vkCode,
                            is_key_down,
                            &mode_key,
                            &active_mods,
                            &ctx.mode_toggle_pressed,
                        ) {
                            if pressed {
                                if !ctx.mode_toggle_pressed.swap(true, Ordering::SeqCst) {
                                    (ctx.mode_toggle_handler)(true);
                                }
                            } else {
                                ctx.mode_toggle_pressed.store(false, Ordering::SeqCst);
                            }
                        }
                    }
                }
            }
        }

        CallNextHookEx(None, n_code, w_param, l_param)
    }
}

// ========== Plugin Init ==========

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("hotkey-listener")
        .setup(move |app, _api| {
            #[cfg(target_os = "macos")]
            let default_key = TriggerKey::Fn;
            #[cfg(target_os = "windows")]
            let default_key = TriggerKey::RightAlt;
            #[cfg(not(any(target_os = "macos", target_os = "windows")))]
            let default_key = TriggerKey::Control;

            let state = HotkeyListenerState {
                shared: Arc::new(Mutex::new(HotkeySharedState {
                    trigger_key: default_key,
                    trigger_mode: TriggerMode::Hold,
                    mode_toggle_key: None,
                    active_modifiers: HashSet::new(),
                    recording: RecordingState::new(),
                })),
                is_pressed: Arc::new(AtomicBool::new(false)),
                is_toggled_on: Arc::new(AtomicBool::new(false)),
                mode_toggle_pressed: Arc::new(AtomicBool::new(false)),
                #[cfg(target_os = "macos")]
                run_loop_ref: Arc::new(Mutex::new(None)),
            };

            let hook_state = state.clone();
            let configure_state = state.clone();
            app.listen_global("hotkey:configure-mode-toggle", move |event| {
                let payload = event.payload();
                if payload.trim().is_empty() || payload == "null" {
                    configure_state.update_mode_toggle_config(None);
                    return;
                }
                match serde_json::from_str::<TriggerKey>(payload) {
                    Ok(key) => configure_state.update_mode_toggle_config(Some(key)),
                    Err(err) => eprintln!(
                        "[hotkey-listener] invalid mode-toggle config payload: {err}"
                    ),
                }
            });

            app.manage(state);

            #[cfg(target_os = "macos")]
            {
                let trusted = check_accessibility_permission();
                if !trusted {
                    prompt_accessibility_permission();
                    std::thread::sleep(std::time::Duration::from_secs(1));
                }
                start_event_tap(app.clone(), hook_state);
            }

            #[cfg(target_os = "windows")]
            windows_hook::install(app.clone(), hook_state);

            #[cfg(not(any(target_os = "macos", target_os = "windows")))]
            {
                let _ = hook_state;
            }

            Ok(())
        })
        .build()
}

// ========== Tests ==========

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn make_test_state() -> HotkeyListenerState {
        HotkeyListenerState {
            shared: Arc::new(Mutex::new(HotkeySharedState {
                trigger_key: TriggerKey::Fn,
                trigger_mode: TriggerMode::Hold,
                mode_toggle_key: None,
                active_modifiers: HashSet::new(),
                recording: RecordingState::new(),
            })),
            is_pressed: Arc::new(AtomicBool::new(false)),
            is_toggled_on: Arc::new(AtomicBool::new(false)),
            mode_toggle_pressed: Arc::new(AtomicBool::new(false)),
            #[cfg(target_os = "macos")]
            run_loop_ref: Arc::new(Mutex::new(None)),
        }
    }

    #[test]
    fn custom_trigger_key_serde_roundtrip() {
        let key = TriggerKey::Custom { keycode: 96 };
        assert_eq!(serde_json::to_value(&key).unwrap(), json!({"custom": {"keycode": 96}}));
        let decoded: TriggerKey = serde_json::from_value(json!({"custom": {"keycode": 96}})).unwrap();
        assert_eq!(decoded, key);
    }

    #[test]
    fn preset_trigger_key_serde_roundtrip() {
        let key: TriggerKey = serde_json::from_value(json!("fn")).unwrap();
        assert_eq!(key, TriggerKey::Fn);
        assert_eq!(serde_json::to_value(&key).unwrap(), json!("fn"));
    }

    #[test]
    fn combo_matching_requires_exact_modifiers() {
        let mut mods = HashSet::new();
        mods.insert(ModifierFlag::Command);
        assert!(matches_combo_trigger(
            1,
            &[ModifierFlag::Command],
            1,
            &mods
        ));
        mods.insert(ModifierFlag::Shift);
        assert!(!matches_combo_trigger(
            1,
            &[ModifierFlag::Command],
            1,
            &mods
        ));
    }

    #[test]
    fn mode_toggle_is_unassigned_by_default() {
        let state = make_test_state();
        assert!(state.shared.lock().unwrap().mode_toggle_key.is_none());
    }

    #[test]
    fn mode_toggle_config_is_independent_from_recording_hotkey() {
        let state = make_test_state();
        state.update_mode_toggle_config(Some(TriggerKey::Custom { keycode: 42 }));
        let shared = state.shared.lock().unwrap();
        assert_eq!(shared.trigger_key, TriggerKey::Fn);
        assert_eq!(shared.mode_toggle_key, Some(TriggerKey::Custom { keycode: 42 }));
    }

    #[test]
    fn reset_clears_both_pressed_states() {
        let state = make_test_state();
        state.is_pressed.store(true, Ordering::SeqCst);
        state.mode_toggle_pressed.store(true, Ordering::SeqCst);
        state.reset_key_states();
        assert!(!state.is_pressed.load(Ordering::SeqCst));
        assert!(!state.mode_toggle_pressed.load(Ordering::SeqCst));
    }
}
