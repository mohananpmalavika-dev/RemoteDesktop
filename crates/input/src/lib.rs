use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct DisplayBounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub dpi_scale: f32,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct NormalizedPoint {
    pub x: f32, // 0.0 to 1.0
    pub y: f32, // 0.0 to 1.0
}

impl NormalizedPoint {
    pub fn new(x: f32, y: f32) -> Self {
        Self {
            x: x.clamp(0.0, 1.0),
            y: y.clamp(0.0, 1.0),
        }
    }

    /// Map normalized coordinates (0.0..1.0) to actual physical screen coordinates
    /// taking into account display offset and dimensions (Section 16).
    pub fn to_screen_coordinates(&self, bounds: &DisplayBounds) -> (i32, i32) {
        let abs_x = bounds.x + (self.x * bounds.width as f32).round() as i32;
        let abs_y = bounds.y + (self.y * bounds.height as f32).round() as i32;
        (abs_x, abs_y)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub enum MouseButton {
    Left,
    Right,
    Middle,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum MouseAction {
    Move { point: NormalizedPoint },
    ButtonDown { button: MouseButton, point: NormalizedPoint },
    ButtonUp { button: MouseButton, point: NormalizedPoint },
    Scroll { delta_x: i32, delta_y: i32 },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum KeyAction {
    KeyDown { virtual_key: u16 },
    KeyUp { virtual_key: u16 },
    UnicodeChar { ch: char },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SpecialCombo {
    CtrlAltDel,
    AltTab,
    WinKey,
    CtrlShiftEsc,
    WinL,
}

pub trait InputController: Send + Sync {
    fn inject_mouse(&mut self, action: MouseAction, bounds: &DisplayBounds) -> Result<(), String>;
    fn inject_keyboard(&mut self, action: KeyAction) -> Result<(), String>;
    fn inject_special_combo(&mut self, combo: SpecialCombo) -> Result<(), String>;
}

#[cfg(windows)]
mod windows_impl;

#[cfg(windows)]
pub use windows_impl::WindowsInputInjector;

pub fn create_best_input_controller() -> Box<dyn InputController> {
    #[cfg(windows)]
    {
        Box::new(WindowsInputInjector::new())
    }
    #[cfg(not(windows))]
    {
        panic!("Input injection is currently only implemented for Windows targets");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_coordinate_mapping_primary_monitor() {
        let bounds = DisplayBounds {
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
            dpi_scale: 1.0,
        };

        let center = NormalizedPoint::new(0.5, 0.5);
        let (cx, cy) = center.to_screen_coordinates(&bounds);
        assert_eq!(cx, 960);
        assert_eq!(cy, 540);

        let bottom_right = NormalizedPoint::new(1.0, 1.0);
        let (brx, bry) = bottom_right.to_screen_coordinates(&bounds);
        assert_eq!(brx, 1920);
        assert_eq!(bry, 1080);
    }

    #[test]
    fn test_coordinate_mapping_secondary_monitor() {
        // Monitor placed to the right of primary monitor
        let bounds = DisplayBounds {
            x: 1920,
            y: 0,
            width: 2560,
            height: 1440,
            dpi_scale: 1.25,
        };

        let point = NormalizedPoint::new(0.25, 0.5);
        let (px, py) = point.to_screen_coordinates(&bounds);
        assert_eq!(px, 1920 + 640);
        assert_eq!(py, 720);
    }

    #[test]
    fn test_coordinate_mapping_negative_offset() {
        // Monitor placed to the left or above primary monitor (negative virtual coordinates)
        let bounds = DisplayBounds {
            x: -1920,
            y: -200,
            width: 1920,
            height: 1080,
            dpi_scale: 1.0,
        };

        let center = NormalizedPoint::new(0.5, 0.5);
        let (cx, cy) = center.to_screen_coordinates(&bounds);
        assert_eq!(cx, -1920 + 960);
        assert_eq!(cy, -200 + 540);
    }

    #[test]
    fn test_clamping_out_of_bounds() {
        let p = NormalizedPoint::new(-0.2, 1.5);
        assert_eq!(p.x, 0.0);
        assert_eq!(p.y, 1.0);
    }

    #[test]
    fn test_mouse_action_serialization() {
        let action = MouseAction::ButtonDown {
            button: MouseButton::Left,
            point: NormalizedPoint::new(0.42, 0.88),
        };
        let serialized = serde_json::to_string(&action).unwrap();
        let deserialized: MouseAction = serde_json::from_str(&serialized).unwrap();
        assert_eq!(action, deserialized);
    }

    #[test]
    fn test_key_action_serialization() {
        let action = KeyAction::KeyDown { virtual_key: 0x41 }; // 'A'
        let serialized = serde_json::to_string(&action).unwrap();
        let deserialized: KeyAction = serde_json::from_str(&serialized).unwrap();
        assert_eq!(action, deserialized);

        let unicode = KeyAction::UnicodeChar { ch: '€' };
        let serialized = serde_json::to_string(&unicode).unwrap();
        let deserialized: KeyAction = serde_json::from_str(&serialized).unwrap();
        assert_eq!(unicode, deserialized);
    }

    #[test]
    fn test_special_combo_serialization() {
        let combo = SpecialCombo::CtrlAltDel;
        let serialized = serde_json::to_string(&combo).unwrap();
        let deserialized: SpecialCombo = serde_json::from_str(&serialized).unwrap();
        assert_eq!(combo, deserialized);
    }

    #[cfg(windows)]
    #[test]
    fn test_windows_input_injector_toggle_and_bounds() {
        let mut injector = WindowsInputInjector::new();
        assert!(injector.is_enabled());

        // Test normalized coordinate conversion does not panic
        let (nx, ny) = WindowsInputInjector::to_virtual_screen_normalized(500, 500);
        assert!(nx >= 0 && nx <= 65535);
        assert!(ny >= 0 && ny <= 65535);

        // Test disabling blocks input
        injector.set_enabled(false);
        assert!(!injector.is_enabled());

        let bounds = DisplayBounds {
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
            dpi_scale: 1.0,
        };
        let res = injector.inject_mouse(
            MouseAction::Move {
                point: NormalizedPoint::new(0.5, 0.5),
            },
            &bounds,
        );
        assert!(res.is_err(), "Disabled injector must reject mouse input");
        assert!(res.unwrap_err().contains("disabled"));

        let res_key = injector.inject_keyboard(KeyAction::KeyDown { virtual_key: 0x20 });
        assert!(res_key.is_err(), "Disabled injector must reject keyboard input");
    }
}
