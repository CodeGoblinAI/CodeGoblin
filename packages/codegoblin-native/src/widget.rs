//! `codegoblin-native widget` — a tiny always-on-top status bubble for Windows.
//!
//! The TUI spawns this binary and streams JSON lines on stdin:
//!   {"title":"fix auth bug","working":true,"status":"Running bash","spend":"$0.42","startedAtMs":1721312345000}
//! Fields are optional; each line merges into the current state. When stdin
//! closes (TUI exit), the widget exits. No network, no discovery, no config.
//!
//! Interactions: drag anywhere to move, double-click to refocus the terminal
//! window that launched the TUI, right-click to dismiss.

#[cfg(windows)]
pub fn run() -> Result<(), String> {
    win::run()
}

#[cfg(not(windows))]
pub fn run() -> Result<(), String> {
    Err("the status widget is currently Windows-only".into())
}

#[cfg(windows)]
mod win {
    use serde::Deserialize;
    use std::io::BufRead;
    use std::sync::Mutex;
    use std::time::{SystemTime, UNIX_EPOCH};

    use windows_sys::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, RECT, WPARAM};
    use windows_sys::Win32::Graphics::Dwm::DwmSetWindowAttribute;
    use windows_sys::Win32::Graphics::Gdi::*;
    use windows_sys::Win32::System::Console::GetConsoleWindow;
    use windows_sys::Win32::UI::HiDpi::{
        SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::*;

    #[derive(Default, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Update {
        title: Option<String>,
        status: Option<String>,
        working: Option<bool>,
        spend: Option<String>,
        started_at_ms: Option<u64>,
    }

    #[derive(Default)]
    struct State {
        title: String,
        status: String,
        working: bool,
        spend: String,
        started_at_ms: Option<u64>,
        pulse: bool,
    }

    static STATE: Mutex<Option<State>> = Mutex::new(None);

    const WM_APP_UPDATE: u32 = WM_APP + 1;
    const TIMER_TICK: usize = 1;

    const BG: COLORREF = rgb(0x16, 0x18, 0x1c);
    const EDGE: COLORREF = rgb(0x2a, 0x2d, 0x33);
    const TITLE_FG: COLORREF = rgb(0xe8, 0xe8, 0xe8);
    const STATUS_FG: COLORREF = rgb(0x9a, 0x9f, 0xa6);
    const GREEN: COLORREF = rgb(0x9a, 0xdb, 0x35);
    const GREEN_DIM: COLORREF = rgb(0x4f, 0x70, 0x1e);
    const GOLD: COLORREF = rgb(0xd4, 0xb0, 0x6a);

    const fn rgb(r: u8, g: u8, b: u8) -> COLORREF {
        (r as u32) | ((g as u32) << 8) | ((b as u32) << 16)
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn now_ms() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }

    struct Ctx {
        terminal: HWND,
        scale: f32,
    }

    static CTX: Mutex<Option<(isize, f32)>> = Mutex::new(None);

    fn ctx() -> Ctx {
        let guard = CTX.lock().unwrap();
        let (terminal, scale) = guard.unwrap_or((0, 1.0));
        Ctx { terminal: terminal as HWND, scale }
    }

    fn px(ctx: &Ctx, v: i32) -> i32 {
        ((v as f32) * ctx.scale).round() as i32
    }

    pub fn run() -> Result<(), String> {
        unsafe {
            let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);

            // Whoever is foreground at launch is almost always the terminal the
            // user toggled the widget from; remember it for double-click focus.
            let terminal = GetForegroundWindow();

            let instance = windows_sys::Win32::System::LibraryLoader::GetModuleHandleW(std::ptr::null());
            let class_name = wide("CodeGoblinWidget");
            let wc = WNDCLASSW {
                style: CS_HREDRAW | CS_VREDRAW | CS_DBLCLKS,
                lpfnWndProc: Some(wnd_proc),
                cbClsExtra: 0,
                cbWndExtra: 0,
                hInstance: instance,
                hIcon: std::ptr::null_mut(),
                hCursor: LoadCursorW(std::ptr::null_mut(), IDC_ARROW),
                hbrBackground: std::ptr::null_mut(),
                lpszMenuName: std::ptr::null(),
                lpszClassName: class_name.as_ptr(),
            };
            if RegisterClassW(&wc) == 0 {
                return Err("RegisterClassW failed".into());
            }

            let dpi = windows_sys::Win32::UI::HiDpi::GetDpiForSystem();
            let scale = (dpi as f32) / 96.0;
            *CTX.lock().unwrap() = Some((terminal as isize, scale));

            let width = ((320.0 * scale).round()) as i32;
            let height = ((64.0 * scale).round()) as i32;

            // Bottom-right of the work area (above the taskbar).
            let mut work = RECT { left: 0, top: 0, right: 1280, bottom: 720 };
            SystemParametersInfoW(SPI_GETWORKAREA, 0, &mut work as *mut _ as *mut _, 0);
            let x = work.right - width - ((16.0 * scale) as i32);
            let y = work.bottom - height - ((16.0 * scale) as i32);

            let title = wide("CodeGoblin");
            let hwnd = CreateWindowExW(
                WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
                class_name.as_ptr(),
                title.as_ptr(),
                WS_POPUP,
                x,
                y,
                width,
                height,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                instance,
                std::ptr::null_mut(),
            );
            if hwnd.is_null() {
                return Err("CreateWindowExW failed".into());
            }

            // Win11 rounded corners; silently ignored on Win10.
            const DWMWA_WINDOW_CORNER_PREFERENCE: u32 = 33;
            const DWMWCP_ROUND: u32 = 2;
            let pref: u32 = DWMWCP_ROUND;
            let _ = DwmSetWindowAttribute(
                hwnd,
                DWMWA_WINDOW_CORNER_PREFERENCE,
                &pref as *const _ as *const _,
                std::mem::size_of::<u32>() as u32,
            );

            ShowWindow(hwnd, SW_SHOWNOACTIVATE);
            SetTimer(hwnd, TIMER_TICK, 600, None);

            spawn_stdin_reader(hwnd as isize);

            let mut msg: MSG = std::mem::zeroed();
            while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
        Ok(())
    }

    fn spawn_stdin_reader(hwnd: isize) {
        std::thread::spawn(move || {
            let stdin = std::io::stdin();
            for line in stdin.lock().lines() {
                let Ok(line) = line else { break };
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                if let Ok(update) = serde_json::from_str::<Update>(trimmed) {
                    let mut guard = STATE.lock().unwrap();
                    let state = guard.get_or_insert_with(State::default);
                    if let Some(v) = update.title {
                        state.title = v;
                    }
                    if let Some(v) = update.status {
                        state.status = v;
                    }
                    if let Some(v) = update.working {
                        state.working = v;
                    }
                    if let Some(v) = update.spend {
                        state.spend = v;
                    }
                    if update.started_at_ms.is_some() {
                        state.started_at_ms = update.started_at_ms;
                    }
                    drop(guard);
                    unsafe {
                        PostMessageW(hwnd as HWND, WM_APP_UPDATE, 0, 0);
                    }
                }
            }
            // stdin closed: the TUI is gone, so leave with it.
            unsafe {
                PostMessageW(hwnd as HWND, WM_CLOSE, 0, 0);
            }
        });
    }

    fn focus_terminal() {
        let ctx = ctx();
        unsafe {
            let mut target = ctx.terminal;
            if target.is_null() || IsWindow(target) == 0 {
                target = GetConsoleWindow();
            }
            if !target.is_null() && IsWindow(target) != 0 {
                if IsIconic(target) != 0 {
                    ShowWindow(target, SW_RESTORE);
                }
                SetForegroundWindow(target);
            }
        }
    }

    unsafe extern "system" fn wnd_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        match msg {
            WM_APP_UPDATE => {
                InvalidateRect(hwnd, std::ptr::null(), 0);
                0
            }
            WM_TIMER => {
                let mut repaint = false;
                {
                    let mut guard = STATE.lock().unwrap();
                    if let Some(state) = guard.as_mut() {
                        if state.working {
                            state.pulse = !state.pulse;
                            repaint = true;
                        }
                    }
                }
                if repaint {
                    InvalidateRect(hwnd, std::ptr::null(), 0);
                }
                0
            }
            WM_NCHITTEST => {
                // Whole surface acts as a caption: drag anywhere.
                HTCAPTION as LRESULT
            }
            WM_NCLBUTTONDBLCLK => {
                focus_terminal();
                0
            }
            WM_NCRBUTTONUP | WM_RBUTTONUP => {
                PostMessageW(hwnd, WM_CLOSE, 0, 0);
                0
            }
            WM_PAINT => {
                paint(hwnd);
                0
            }
            WM_DESTROY => {
                KillTimer(hwnd, TIMER_TICK);
                PostQuitMessage(0);
                0
            }
            _ => DefWindowProcW(hwnd, msg, wparam, lparam),
        }
    }

    unsafe fn draw_text(
        dc: HDC,
        font: HGDIOBJ,
        color: COLORREF,
        rect: &mut RECT,
        text: &str,
        flags: DRAW_TEXT_FORMAT,
    ) {
        let old = SelectObject(dc, font);
        SetTextColor(dc, color);
        let mut buf: Vec<u16> = text.encode_utf16().collect();
        DrawTextW(
            dc,
            buf.as_mut_ptr(),
            buf.len() as i32,
            rect,
            flags | DT_SINGLELINE | DT_NOPREFIX,
        );
        SelectObject(dc, old);
    }

    unsafe fn make_font(ctx: &Ctx, size: i32, weight: i32) -> HGDIOBJ {
        let face = wide("Segoe UI");
        CreateFontW(
            -px(ctx, size),
            0,
            0,
            0,
            weight,
            0,
            0,
            0,
            DEFAULT_CHARSET as u32,
            OUT_DEFAULT_PRECIS as u32,
            CLIP_DEFAULT_PRECIS as u32,
            CLEARTYPE_QUALITY as u32,
            (DEFAULT_PITCH | FF_DONTCARE) as u32,
            face.as_ptr(),
        ) as HGDIOBJ
    }

    fn elapsed_text(state: &State) -> String {
        let Some(start) = state.started_at_ms else {
            return String::new();
        };
        if !state.working {
            return String::new();
        }
        let secs = now_ms().saturating_sub(start) / 1000;
        if secs >= 60 {
            format!("{}m{:02}s", secs / 60, secs % 60)
        } else {
            format!("{}s", secs)
        }
    }

    unsafe fn paint(hwnd: HWND) {
        let ctx = ctx();
        let mut ps: PAINTSTRUCT = std::mem::zeroed();
        let hdc = BeginPaint(hwnd, &mut ps);

        let mut rc: RECT = std::mem::zeroed();
        GetClientRect(hwnd, &mut rc);
        let w = rc.right - rc.left;
        let h = rc.bottom - rc.top;

        // Double-buffer to avoid flicker.
        let mem = CreateCompatibleDC(hdc);
        let bmp = CreateCompatibleBitmap(hdc, w, h);
        let old_bmp = SelectObject(mem, bmp as HGDIOBJ);
        SetBkMode(mem, TRANSPARENT as i32);

        let bg = CreateSolidBrush(BG);
        FillRect(mem, &rc, bg);
        DeleteObject(bg as HGDIOBJ);

        // 1px hairline border so the bubble reads against dark wallpapers.
        let edge = CreateSolidBrush(EDGE);
        let frame = rc;
        FrameRect(mem, &frame, edge);
        DeleteObject(edge as HGDIOBJ);

        let guard = STATE.lock().unwrap();
        let placeholder = State {
            title: "CodeGoblin".into(),
            status: "waiting for the goblin…".into(),
            ..Default::default()
        };
        let state = guard.as_ref().unwrap_or(&placeholder);

        let pad = px(&ctx, 12);
        let dot = px(&ctx, 8);

        // Status dot: pulsing green while working, dim grey at rest.
        let dot_color = if state.working {
            if state.pulse {
                GREEN
            } else {
                GREEN_DIM
            }
        } else {
            EDGE
        };
        let dot_brush = CreateSolidBrush(dot_color);
        let dot_pen = CreatePen(PS_SOLID, 1, dot_color);
        let old_pen = SelectObject(mem, dot_pen as HGDIOBJ);
        let old_brush = SelectObject(mem, dot_brush as HGDIOBJ);
        let dot_y = pad + px(&ctx, 5);
        Ellipse(mem, pad, dot_y, pad + dot, dot_y + dot);
        SelectObject(mem, old_pen);
        SelectObject(mem, old_brush);
        DeleteObject(dot_pen as HGDIOBJ);
        DeleteObject(dot_brush as HGDIOBJ);

        let title_font = make_font(&ctx, 14, 600);
        let body_font = make_font(&ctx, 12, 400);

        // Row 1: title (left, after the dot) + spend (right, gold).
        let mut spend_w = 0;
        if !state.spend.is_empty() {
            spend_w = px(&ctx, 64);
            let mut spend_rc = RECT {
                left: w - pad - spend_w,
                top: pad,
                right: w - pad,
                bottom: pad + px(&ctx, 18),
            };
            draw_text(mem, body_font, GOLD, &mut spend_rc, &state.spend, DT_RIGHT);
        }
        let mut title_rc = RECT {
            left: pad + dot + px(&ctx, 8),
            top: pad - px(&ctx, 2),
            right: w - pad - spend_w - px(&ctx, 4),
            bottom: pad + px(&ctx, 18),
        };
        let title = if state.title.is_empty() { "CodeGoblin" } else { &state.title };
        draw_text(mem, title_font, TITLE_FG, &mut title_rc, title, DT_LEFT | DT_END_ELLIPSIS);

        // Row 2: status (left, grey; green while working) + elapsed (right).
        let elapsed = elapsed_text(state);
        let mut elapsed_w = 0;
        if !elapsed.is_empty() {
            elapsed_w = px(&ctx, 56);
            let mut el_rc = RECT {
                left: w - pad - elapsed_w,
                top: h - pad - px(&ctx, 16),
                right: w - pad,
                bottom: h - pad + px(&ctx, 2),
            };
            draw_text(mem, body_font, STATUS_FG, &mut el_rc, &elapsed, DT_RIGHT);
        }
        let mut status_rc = RECT {
            left: pad,
            top: h - pad - px(&ctx, 16),
            right: w - pad - elapsed_w - px(&ctx, 4),
            bottom: h - pad + px(&ctx, 2),
        };
        let status = if !state.status.is_empty() {
            state.status.as_str()
        } else if state.working {
            "goblin working…"
        } else {
            "idle"
        };
        let status_color = if state.working { GREEN } else { STATUS_FG };
        draw_text(mem, body_font, status_color, &mut status_rc, status, DT_LEFT | DT_END_ELLIPSIS);

        drop(guard);

        DeleteObject(title_font);
        DeleteObject(body_font);

        BitBlt(hdc, 0, 0, w, h, mem, 0, 0, SRCCOPY);
        SelectObject(mem, old_bmp);
        DeleteObject(bmp as HGDIOBJ);
        DeleteDC(mem);

        EndPaint(hwnd, &ps);
    }
}
