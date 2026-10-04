use crate::{
    DisplayBounds, InputController, KeyAction, MouseAction, MouseButton, SpecialCombo,
};
use std::time::Instant;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYBD_EVENT_FLAGS,
    KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, MOUSEINPUT,
    MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_HWHEEL, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP,
    MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_MOVE, MOUSEEVENTF_RIGHTDOWN,
    MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_VIRTUALDESK, MOUSEEVENTF_WHEEL, VIRTUAL_KEY, VK_CONTROL,
    VK_DELETE, VK_ESCAPE, VK_L, VK_LWIN, VK_MENU, VK_SHIFT, VK_TAB,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
    SM_YVIRTUALSCREEN,
};

/// Production Win32 input injector using SendInput.
pub struct WindowsInputInjector {
    enabled: bool,
    last_injection: Option<Instant>,
    total_injected: u64,
}

impl WindowsInputInjector {
    pub fn new() -> Self {
        Self {
            enabled: true,
            last_injection: None,
            total_injected: 0,
        }
    }

    pub fn set_enabled(&mut self, enabled: bool) {
        self.enabled = enabled;
        log::info!("[input] WindowsInputInjector enabled={}", enabled);
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled
    }

    pub fn total_injected(&self) -> u64 {
        self.total_injected
    }

    /// Converts absolute screen coordinates to the normalized 0..65535 space
    /// expected by MOUSEEVENTF_VIRTUALDESK | MOUSEEVENTF_ABSOLUTE.
    pub fn to_virtual_screen_normalized(screen_x: i32, screen_y: i32) -> (i32, i32) {
        unsafe {
            let vx = GetSystemMetrics(SM_XVIRTUALSCREEN);
            let vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
            let vw = GetSystemMetrics(SM_CXVIRTUALSCREEN);
            let vh = GetSystemMetrics(SM_CYVIRTUALSCREEN);

            let vw = if vw <= 0 { 1920 } else { vw };
            let vh = if vh <= 0 { 1080 } else { vh };

            let norm_x = (((screen_x - vx) as i64 * 65535) / vw as i64).clamp(0, 65535) as i32;
            let norm_y = (((screen_y - vy) as i64 * 65535) / vh as i64).clamp(0, 65535) as i32;

            (norm_x, norm_y)
        }
    }

    /// Helper to send one or more INPUT structures via Win32 SendInput.
    fn send_inputs(&mut self, inputs: &[INPUT]) -> Result<(), String> {
        if !self.enabled {
            return Err("Remote input injection is currently disabled on host".into());
        }

        if inputs.is_empty() {
            return Ok(());
        }

        let sent = unsafe {
            SendInput(
                inputs,
                std::mem::size_of::<INPUT>() as i32,
            )
        };

        if sent as usize == inputs.len() {
            self.total_injected += sent as u64;
            self.last_injection = Some(Instant::now());
            Ok(())
        } else {
            Err(format!(
                "SendInput failed: sent {} of {} events",
                sent,
                inputs.len()
            ))
        }
    }
}

impl Default for WindowsInputInjector {
    fn default() -> Self {
        Self::new()
    }
}

impl InputController for WindowsInputInjector {
    fn inject_mouse(&mut self, action: MouseAction, bounds: &DisplayBounds) -> Result<(), String> {
        match action {
            MouseAction::Move { point } => {
                let (sx, sy) = point.to_screen_coordinates(bounds);
                let (norm_x, norm_y) = Self::to_virtual_screen_normalized(sx, sy);

                let input = INPUT {
                    r#type: INPUT_MOUSE,
                    Anonymous: INPUT_0 {
                        mi: MOUSEINPUT {
                            dx: norm_x,
                            dy: norm_y,
                            mouseData: 0,
                            dwFlags: MOUSEEVENTF_MOVE
                                | MOUSEEVENTF_ABSOLUTE
                                | MOUSEEVENTF_VIRTUALDESK,
                            time: 0,
                            dwExtraInfo: 0,
                        },
                    },
                };
                self.send_inputs(&[input])
            }
            MouseAction::ButtonDown { button, point } => {
                let (sx, sy) = point.to_screen_coordinates(bounds);
                let (norm_x, norm_y) = Self::to_virtual_screen_normalized(sx, sy);

                let flag = match button {
                    MouseButton::Left => MOUSEEVENTF_LEFTDOWN,
                    MouseButton::Right => MOUSEEVENTF_RIGHTDOWN,
                    MouseButton::Middle => MOUSEEVENTF_MIDDLEDOWN,
                };

                let input = INPUT {
                    r#type: INPUT_MOUSE,
                    Anonymous: INPUT_0 {
                        mi: MOUSEINPUT {
                            dx: norm_x,
                            dy: norm_y,
                            mouseData: 0,
                            dwFlags: MOUSEEVENTF_MOVE
                                | MOUSEEVENTF_ABSOLUTE
                                | MOUSEEVENTF_VIRTUALDESK
                                | flag,
                            time: 0,
                            dwExtraInfo: 0,
                        },
                    },
                };
                self.send_inputs(&[input])
            }
            MouseAction::ButtonUp { button, point } => {
                let (sx, sy) = point.to_screen_coordinates(bounds);
                let (norm_x, norm_y) = Self::to_virtual_screen_normalized(sx, sy);

                let flag = match button {
                    MouseButton::Left => MOUSEEVENTF_LEFTUP,
                    MouseButton::Right => MOUSEEVENTF_RIGHTUP,
                    MouseButton::Middle => MOUSEEVENTF_MIDDLEUP,
                };

                let input = INPUT {
                    r#type: INPUT_MOUSE,
                    Anonymous: INPUT_0 {
                        mi: MOUSEINPUT {
                            dx: norm_x,
                            dy: norm_y,
                            mouseData: 0,
                            dwFlags: MOUSEEVENTF_MOVE
                                | MOUSEEVENTF_ABSOLUTE
                                | MOUSEEVENTF_VIRTUALDESK
                                | flag,
                            time: 0,
                            dwExtraInfo: 0,
                        },
                    },
                };
                self.send_inputs(&[input])
            }
            MouseAction::Scroll { delta_x, delta_y } => {
                let mut inputs = Vec::new();
                if delta_y != 0 {
                    inputs.push(INPUT {
                        r#type: INPUT_MOUSE,
                        Anonymous: INPUT_0 {
                            mi: MOUSEINPUT {
                                dx: 0,
                                dy: 0,
                                mouseData: (delta_y * 120) as u32,
                                dwFlags: MOUSEEVENTF_WHEEL,
                                time: 0,
                                dwExtraInfo: 0,
                            },
                        },
                    });
                }
                if delta_x != 0 {
                    inputs.push(INPUT {
                        r#type: INPUT_MOUSE,
                        Anonymous: INPUT_0 {
                            mi: MOUSEINPUT {
                                dx: 0,
                                dy: 0,
                                mouseData: (delta_x * 120) as u32,
                                dwFlags: MOUSEEVENTF_HWHEEL,
                                time: 0,
                                dwExtraInfo: 0,
                            },
                        },
                    });
                }
                self.send_inputs(&inputs)
            }
        }
    }

    fn inject_keyboard(&mut self, action: KeyAction) -> Result<(), String> {
        let input = match action {
            KeyAction::KeyDown { virtual_key } => {
                let mut flags = KEYBD_EVENT_FLAGS(0);
                if is_extended_key(virtual_key) {
                    flags |= KEYEVENTF_EXTENDEDKEY;
                }
                INPUT {
                    r#type: INPUT_KEYBOARD,
                    Anonymous: INPUT_0 {
                        ki: KEYBDINPUT {
                            wVk: VIRTUAL_KEY(virtual_key),
                            wScan: 0,
                            dwFlags: flags,
                            time: 0,
                            dwExtraInfo: 0,
                        },
                    },
                }
            }
            KeyAction::KeyUp { virtual_key } => {
                let mut flags = KEYEVENTF_KEYUP;
                if is_extended_key(virtual_key) {
                    flags |= KEYEVENTF_EXTENDEDKEY;
                }
                INPUT {
                    r#type: INPUT_KEYBOARD,
                    Anonymous: INPUT_0 {
                        ki: KEYBDINPUT {
                            wVk: VIRTUAL_KEY(virtual_key),
                            wScan: 0,
                            dwFlags: flags,
                            time: 0,
                            dwExtraInfo: 0,
                        },
                    },
                }
            }
            KeyAction::UnicodeChar { ch } => INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: VIRTUAL_KEY(0),
                        wScan: ch as u16,
                        dwFlags: KEYEVENTF_UNICODE,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            },
        };
        self.send_inputs(&[input])
    }

    fn inject_special_combo(&mut self, combo: SpecialCombo) -> Result<(), String> {
        match combo {
            SpecialCombo::AltTab => {
                // Alt down, Tab down, Tab up, Alt up
                let inputs = [
                    make_key_input(VK_MENU.0, false),
                    make_key_input(VK_TAB.0, false),
                    make_key_input(VK_TAB.0, true),
                    make_key_input(VK_MENU.0, true),
                ];
                self.send_inputs(&inputs)
            }
            SpecialCombo::WinKey => {
                // Windows key press and release
                let inputs = [
                    make_key_input(VK_LWIN.0, false),
                    make_key_input(VK_LWIN.0, true),
                ];
                self.send_inputs(&inputs)
            }
            SpecialCombo::CtrlShiftEsc => {
                // Task Manager: Ctrl + Shift + Esc
                let inputs = [
                    make_key_input(VK_CONTROL.0, false),
                    make_key_input(VK_SHIFT.0, false),
                    make_key_input(VK_ESCAPE.0, false),
                    make_key_input(VK_ESCAPE.0, true),
                    make_key_input(VK_SHIFT.0, true),
                    make_key_input(VK_CONTROL.0, true),
                ];
                self.send_inputs(&inputs)
            }
            SpecialCombo::WinL => {
                // Lock screen: Win + L
                let inputs = [
                    make_key_input(VK_LWIN.0, false),
                    make_key_input(VK_L.0, false),
                    make_key_input(VK_L.0, true),
                    make_key_input(VK_LWIN.0, true),
                ];
                self.send_inputs(&inputs)
            }
            SpecialCombo::CtrlAltDel => {
                let inputs = [
                    make_key_input(VK_CONTROL.0, false),
                    make_key_input(VK_MENU.0, false),
                    make_key_input(VK_DELETE.0, false),
                    make_key_input(VK_DELETE.0, true),
                    make_key_input(VK_MENU.0, true),
                    make_key_input(VK_CONTROL.0, true),
                ];
                self.send_inputs(&inputs)
            }
        }
    }
}

fn make_key_input(vk: u16, key_up: bool) -> INPUT {
    let mut flags = if key_up {
        KEYEVENTF_KEYUP
    } else {
        KEYBD_EVENT_FLAGS(0)
    };
    if is_extended_key(vk) {
        flags |= KEYEVENTF_EXTENDEDKEY;
    }
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(vk),
                wScan: 0,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

fn is_extended_key(vk: u16) -> bool {
    matches!(
        vk,
        0x21 // VK_PRIOR (Page Up)
        | 0x22 // VK_NEXT (Page Down)
        | 0x23 // VK_END
        | 0x24 // VK_HOME
        | 0x25 // VK_LEFT
        | 0x26 // VK_UP
        | 0x27 // VK_RIGHT
        | 0x28 // VK_DOWN
        | 0x2D // VK_INSERT
        | 0x2E // VK_DELETE
        | 0x5B // VK_LWIN
        | 0x5C // VK_RWIN
        | 0xA3 // VK_RCONTROL
        | 0xA5 // VK_RMENU (Right Alt)
    )
}
