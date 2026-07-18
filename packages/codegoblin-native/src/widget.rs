//! `codegoblin-native widget` — a tiny always-on-top status bubble for Windows.
//!
//! The TUI spawns this binary and streams JSON lines on stdin:
//!   {"title":"fix auth bug","working":true,"status":"bash","startedAtMs":1721312345000}
//!   {"working":false,"done":true,"status":"done · 1m27s"}
//!   {"sound":true,"soundPath":"C:\\...\\widget.wav"}
//! Fields are optional; each line merges into the current state. When stdin
//! closes (TUI exit), the widget exits. No network, no discovery.
//!
//! The widget reports user preference changes as JSON lines on stdout
//! (currently `{"event":"sound","enabled":bool}`) so the TUI can persist them.
//!
//! Interactions:
//!   - drag anywhere to move; drop near the top/left/right monitor edge to
//!     dock it as a small tab (PC-Manager style); hover the tab to fly out
//!   - hover shows a menu row: focus terminal / sound on-off / hide
//!   - double-click refocuses the terminal, right-click dismisses

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

    use windows_sys::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
    use windows_sys::Win32::Graphics::Dwm::DwmSetWindowAttribute;
    use windows_sys::Win32::Graphics::Gdi::*;
    use windows_sys::Win32::Media::Audio::{PlaySoundW, SND_ASYNC, SND_FILENAME, SND_NODEFAULT};
    use windows_sys::Win32::System::Console::GetConsoleWindow;
    use windows_sys::Win32::UI::HiDpi::{
        SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
    };
    use windows_sys::Win32::System::Diagnostics::Debug::MessageBeep;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        TrackMouseEvent, TME_LEAVE, TME_NONCLIENT, TRACKMOUSEEVENT,
    };

    // Lives in the Win32_UI_Controls feature; not worth pulling that in for one constant.
    const WM_MOUSELEAVE: u32 = 0x02a3;
    use windows_sys::Win32::UI::WindowsAndMessaging::*;

    #[derive(Default, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Update {
        title: Option<String>,
        status: Option<String>,
        working: Option<bool>,
        spend: Option<String>,
        started_at_ms: Option<u64>,
        done: Option<bool>,
        sound: Option<bool>,
        sound_path: Option<String>,
    }

    struct State {
        title: String,
        status: String,
        working: bool,
        spend: String,
        started_at_ms: Option<u64>,
        done: bool,
        sound_enabled: bool,
        sound_path: Option<String>,
    }

    impl Default for State {
        fn default() -> Self {
            Self {
                title: String::new(),
                status: String::new(),
                working: false,
                spend: String::new(),
                started_at_ms: None,
                done: false,
                sound_enabled: true,
                sound_path: None,
            }
        }
    }

    #[derive(Clone, Copy, PartialEq)]
    enum Edge {
        Top,
        Left,
        Right,
    }

    #[derive(Clone, Copy, PartialEq)]
    enum Mode {
        Floating,
        DockedTab,
        DockedExpanded,
    }

    struct Ui {
        mode: Mode,
        edge: Edge,
        /// Coordinate along the docked edge (x for top, y for sides).
        along: i32,
        hovering: bool,
        in_drag: bool,
        pulse: bool,
        frame: u8,
        /// Remaining pulse ticks of the "done" border flash.
        flash: u8,
        /// Menu button rects (client coords), recomputed at paint.
        buttons: [RECT; 3],
    }

    const ZERO_RECT: RECT = RECT { left: 0, top: 0, right: 0, bottom: 0 };

    static STATE: Mutex<Option<State>> = Mutex::new(None);
    static UI: Mutex<Ui> = Mutex::new(Ui {
        mode: Mode::Floating,
        edge: Edge::Top,
        along: 0,
        hovering: false,
        in_drag: false,
        pulse: false,
        frame: 0,
        flash: 0,
        buttons: [ZERO_RECT; 3],
    });
    static CTX: Mutex<Option<(isize, f32)>> = Mutex::new(None);

    const WM_APP_UPDATE: u32 = WM_APP + 1;
    const WM_APP_DONE: u32 = WM_APP + 2;
    const TIMER_TICK: usize = 1;

    // 96-dpi layout constants (multiplied by the dpi scale at runtime).
    const BUBBLE_W: i32 = 320;
    const BUBBLE_H: i32 = 84;
    const MENU_H: i32 = 24;
    const TAB_LEN: i32 = 56;
    const TAB_THICK: i32 = 12;
    const SNAP: i32 = 16;

    const BG: COLORREF = rgb(0x16, 0x18, 0x1c);
    const EDGE_C: COLORREF = rgb(0x2a, 0x2d, 0x33);
    const TAB_BG: COLORREF = rgb(0x3a, 0x3d, 0x44);
    const TITLE_FG: COLORREF = rgb(0xe8, 0xe8, 0xe8);
    const STATUS_FG: COLORREF = rgb(0x9a, 0x9f, 0xa6);
    const GREEN: COLORREF = rgb(0x9a, 0xdb, 0x35);
    const GREEN_DIM: COLORREF = rgb(0x4f, 0x70, 0x1e);
    const GOLD: COLORREF = rgb(0xd4, 0xb0, 0x6a);
    const EYE: COLORREF = rgb(0x10, 0x12, 0x14);
    const WHITE: COLORREF = rgb(0xff, 0xff, 0xff);

    const fn rgb(r: u8, g: u8, b: u8) -> COLORREF {
        (r as u32) | ((g as u32) << 8) | ((b as u32) << 16)
    }

    // ── goblin mascot ────────────────────────────────────────────────────────
    // 14x12 pixel grids: G skin, D dark shade, B eyes, T gold, W sparkle.

    const GOBLIN_OPEN: [&str; 12] = [
        ".G..........G.",
        ".GG........GG.",
        ".GGGGGGGGGGGG.",
        "..GGGGGGGGGG..",
        ".GGGGGGGGGGGG.",
        ".GGBBGGGGBBGG.",
        ".GGBBGGGGBBGG.",
        ".GGGGGGGGGGGG.",
        "..GGGGGGGGGG..",
        "..GGDDDDDDGG..",
        "...GGGGGGGG...",
        "....GGGGGG....",
    ];

    const GOBLIN_BLINK: [&str; 12] = [
        ".G..........G.",
        ".GG........GG.",
        ".GGGGGGGGGGGG.",
        "..GGGGGGGGGG..",
        ".GGGGGGGGGGGG.",
        ".GGGGGGGGGGGG.",
        ".GGDDGGGGDDGG.",
        ".GGGGGGGGGGGG.",
        "..GGGGGGGGGG..",
        "..GGDDDDDDGG..",
        "...GGGGGGGG...",
        "....GGGGGG....",
    ];

    const GOBLIN_HAPPY: [&str; 12] = [
        ".G....W.....G.",
        ".GG..WTW...GG.",
        ".GGGGGWGGGGGG.",
        "..GGGGGGGGGG..",
        ".GGGGGGGGGGGG.",
        ".GGBBGGGGBBGG.",
        ".GGGGGGGGGGGG.",
        ".GGGGGGGGGGGG.",
        "..GDGGGGGGDG..",
        "..GGDDDDDDGG..",
        "...GGGGGGGG...",
        "....GGGGGG....",
    ];

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

    fn ctx() -> Ctx {
        let guard = CTX.lock().unwrap();
        let (terminal, scale) = guard.unwrap_or((0, 1.0));
        Ctx { terminal: terminal as HWND, scale }
    }

    fn px(ctx: &Ctx, v: i32) -> i32 {
        ((v as f32) * ctx.scale).round() as i32
    }

    fn emit_stdout(line: &str) {
        use std::io::Write;
        let mut out = std::io::stdout();
        let _ = out.write_all(line.as_bytes());
        let _ = out.write_all(b"\n");
        let _ = out.flush();
    }

    fn play_done_sound() {
        let (enabled, path) = {
            let guard = STATE.lock().unwrap();
            let state = match guard.as_ref() {
                Some(s) => s,
                None => return,
            };
            (state.sound_enabled, state.sound_path.clone())
        };
        if !enabled {
            return;
        }
        unsafe {
            if let Some(path) = path {
                let w = wide(&path);
                if PlaySoundW(w.as_ptr(), std::ptr::null_mut(), SND_ASYNC | SND_FILENAME | SND_NODEFAULT) != 0 {
                    return;
                }
            }
            // Default bell: the system "asterisk" chime.
            MessageBeep(MB_ICONASTERISK);
        }
    }

    pub fn run() -> Result<(), String> {
        unsafe {
            let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);

            // Whoever is foreground at launch is almost always the terminal the
            // user toggled the widget from; remember it for click-to-focus.
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
            let c = ctx();

            let width = px(&c, BUBBLE_W);
            let height = px(&c, BUBBLE_H);

            // Bottom-right of the work area (above the taskbar).
            let mut work = RECT { left: 0, top: 0, right: 1280, bottom: 720 };
            SystemParametersInfoW(SPI_GETWORKAREA, 0, &mut work as *mut _ as *mut _, 0);
            let x = work.right - width - px(&c, 16);
            let y = work.bottom - height - px(&c, 16);

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
                let Ok(update) = serde_json::from_str::<Update>(trimmed) else {
                    continue;
                };
                let mut finished = false;
                {
                    let mut guard = STATE.lock().unwrap();
                    let state = guard.get_or_insert_with(State::default);
                    if let Some(v) = update.title {
                        state.title = v;
                    }
                    if let Some(v) = update.status {
                        state.status = v;
                    }
                    if let Some(v) = update.working {
                        if v && state.done {
                            state.done = false;
                        }
                        state.working = v;
                    }
                    if let Some(v) = update.spend {
                        state.spend = v;
                    }
                    if update.started_at_ms.is_some() {
                        state.started_at_ms = update.started_at_ms;
                    }
                    if let Some(v) = update.sound {
                        state.sound_enabled = v;
                    }
                    if update.sound_path.is_some() {
                        state.sound_path = update.sound_path;
                    }
                    if update.done == Some(true) && !state.done {
                        state.done = true;
                        state.working = false;
                        finished = true;
                    }
                }
                unsafe {
                    PostMessageW(hwnd as HWND, if finished { WM_APP_DONE } else { WM_APP_UPDATE }, 0, 0);
                }
                if finished {
                    play_done_sound();
                }
            }
            // stdin closed: the TUI is gone, so leave with it.
            unsafe {
                PostMessageW(hwnd as HWND, WM_CLOSE, 0, 0);
            }
        });
    }

    fn focus_terminal() {
        let c = ctx();
        unsafe {
            let mut target = c.terminal;
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

    // ── docking geometry ─────────────────────────────────────────────────────

    fn monitor_rect(hwnd: HWND) -> RECT {
        unsafe {
            let mon = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
            let mut info: MONITORINFO = std::mem::zeroed();
            info.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
            if GetMonitorInfoW(mon, &mut info) != 0 {
                info.rcMonitor
            } else {
                RECT { left: 0, top: 0, right: 1920, bottom: 1080 }
            }
        }
    }

    fn window_rect(hwnd: HWND) -> RECT {
        let mut rc: RECT = unsafe { std::mem::zeroed() };
        unsafe { GetWindowRect(hwnd, &mut rc) };
        rc
    }

    fn set_rect(hwnd: HWND, x: i32, y: i32, w: i32, h: i32) {
        unsafe {
            SetWindowPos(hwnd, std::ptr::null_mut(), x, y, w, h, SWP_NOACTIVATE | SWP_NOZORDER);
        }
    }

    fn tab_rect(c: &Ctx, mon: &RECT, edge: Edge, along: i32) -> (i32, i32, i32, i32) {
        let len = px(c, TAB_LEN);
        let thick = px(c, TAB_THICK);
        match edge {
            Edge::Top => (along.clamp(mon.left, mon.right - len), mon.top, len, thick),
            Edge::Left => (mon.left, along.clamp(mon.top, mon.bottom - len), thick, len),
            Edge::Right => (mon.right - thick, along.clamp(mon.top, mon.bottom - len), thick, len),
        }
    }

    fn expanded_rect(c: &Ctx, mon: &RECT, edge: Edge, along: i32) -> (i32, i32, i32, i32) {
        let w = px(c, BUBBLE_W);
        let h = px(c, BUBBLE_H);
        match edge {
            Edge::Top => (along.clamp(mon.left, mon.right - w), mon.top, w, h),
            Edge::Left => (mon.left, along.clamp(mon.top, mon.bottom - h), w, h),
            Edge::Right => (mon.right - w, along.clamp(mon.top, mon.bottom - h), w, h),
        }
    }

    /// After a drag: dock if dropped near an edge, otherwise float.
    fn settle_after_drag(hwnd: HWND) {
        let c = ctx();
        let mon = monitor_rect(hwnd);
        let rc = window_rect(hwnd);
        let snap = px(&c, SNAP);

        let edge = if rc.top - mon.top < snap {
            Some(Edge::Top)
        } else if mon.right - rc.right < snap {
            Some(Edge::Right)
        } else if rc.left - mon.left < snap {
            Some(Edge::Left)
        } else {
            None
        };

        let mut ui = UI.lock().unwrap();
        match edge {
            Some(edge) => {
                ui.mode = Mode::DockedExpanded;
                ui.edge = edge;
                ui.along = match edge {
                    Edge::Top => rc.left,
                    Edge::Left | Edge::Right => rc.top,
                };
                let (x, y, w, h) = expanded_rect(&c, &mon, edge, ui.along);
                drop(ui);
                set_rect(hwnd, x, y, w, h);
            }
            None => {
                ui.mode = Mode::Floating;
                let (w, h) = (px(&c, BUBBLE_W), px(&c, BUBBLE_H));
                drop(ui);
                set_rect(hwnd, rc.left, rc.top, w, h);
            }
        }
        unsafe { InvalidateRect(hwnd, std::ptr::null(), 0) };
    }

    fn expand_from_tab(hwnd: HWND) {
        let c = ctx();
        let mon = monitor_rect(hwnd);
        let mut ui = UI.lock().unwrap();
        if ui.mode != Mode::DockedTab {
            return;
        }
        ui.mode = Mode::DockedExpanded;
        let (x, y, w, h) = expanded_rect(&c, &mon, ui.edge, ui.along);
        drop(ui);
        set_rect(hwnd, x, y, w, h);
        unsafe { InvalidateRect(hwnd, std::ptr::null(), 0) };
    }

    fn collapse_to_tab(hwnd: HWND) {
        let c = ctx();
        let mon = monitor_rect(hwnd);
        let mut ui = UI.lock().unwrap();
        if ui.mode != Mode::DockedExpanded || ui.in_drag {
            return;
        }
        ui.mode = Mode::DockedTab;
        let (x, y, w, h) = tab_rect(&c, &mon, ui.edge, ui.along);
        drop(ui);
        set_rect(hwnd, x, y, w, h);
        unsafe { InvalidateRect(hwnd, std::ptr::null(), 0) };
    }

    fn track_leave(hwnd: HWND, nonclient: bool) {
        let mut tme = TRACKMOUSEEVENT {
            cbSize: std::mem::size_of::<TRACKMOUSEEVENT>() as u32,
            dwFlags: if nonclient { TME_LEAVE | TME_NONCLIENT } else { TME_LEAVE },
            hwndTrack: hwnd,
            dwHoverTime: 0,
        };
        unsafe { TrackMouseEvent(&mut tme) };
    }

    fn on_hover(hwnd: HWND, nonclient: bool) {
        let (was_hovering, is_tab) = {
            let mut ui = UI.lock().unwrap();
            let was = ui.hovering;
            ui.hovering = true;
            (was, ui.mode == Mode::DockedTab)
        };
        track_leave(hwnd, nonclient);
        if is_tab {
            expand_from_tab(hwnd);
        } else if !was_hovering {
            unsafe { InvalidateRect(hwnd, std::ptr::null(), 0) };
        }
    }

    fn on_leave(hwnd: HWND) {
        // The cursor may have moved between our client and non-client areas —
        // only treat it as a real leave when it is outside the window rect.
        let mut pt = POINT { x: 0, y: 0 };
        unsafe { GetCursorPos(&mut pt) };
        let rc = window_rect(hwnd);
        if pt.x >= rc.left && pt.x < rc.right && pt.y >= rc.top && pt.y < rc.bottom {
            return;
        }
        let expanded = {
            let mut ui = UI.lock().unwrap();
            ui.hovering = false;
            ui.mode == Mode::DockedExpanded
        };
        if expanded {
            collapse_to_tab(hwnd);
        } else {
            unsafe { InvalidateRect(hwnd, std::ptr::null(), 0) };
        }
    }

    fn toggle_sound() -> bool {
        let mut guard = STATE.lock().unwrap();
        let state = guard.get_or_insert_with(State::default);
        state.sound_enabled = !state.sound_enabled;
        let enabled = state.sound_enabled;
        drop(guard);
        emit_stdout(&format!("{{\"event\":\"sound\",\"enabled\":{enabled}}}"));
        enabled
    }

    unsafe extern "system" fn wnd_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        match msg {
            WM_APP_UPDATE => {
                InvalidateRect(hwnd, std::ptr::null(), 0);
                0
            }
            WM_APP_DONE => {
                {
                    let mut ui = UI.lock().unwrap();
                    ui.flash = 6;
                }
                InvalidateRect(hwnd, std::ptr::null(), 0);
                0
            }
            WM_TIMER => {
                let mut repaint = false;
                {
                    let mut ui = UI.lock().unwrap();
                    let working = STATE.lock().unwrap().as_ref().map(|s| s.working).unwrap_or(false);
                    if working {
                        ui.pulse = !ui.pulse;
                        ui.frame = ui.frame.wrapping_add(1);
                        repaint = true;
                    }
                    if ui.flash > 0 {
                        ui.flash -= 1;
                        repaint = true;
                    }
                }
                if repaint {
                    InvalidateRect(hwnd, std::ptr::null(), 0);
                }
                0
            }
            WM_NCHITTEST => {
                let c = ctx();
                let ui = UI.lock().unwrap();
                if ui.mode != Mode::DockedTab && ui.hovering {
                    // The menu row is clickable; everything else drags.
                    let mut pt = POINT {
                        x: (lparam & 0xffff) as i16 as i32,
                        y: ((lparam >> 16) & 0xffff) as i16 as i32,
                    };
                    ScreenToClient(hwnd, &mut pt);
                    let rc = window_rect(hwnd);
                    let h = rc.bottom - rc.top;
                    if pt.y >= h - px(&c, MENU_H) {
                        return HTCLIENT as LRESULT;
                    }
                }
                HTCAPTION as LRESULT
            }
            WM_ENTERSIZEMOVE => {
                UI.lock().unwrap().in_drag = true;
                0
            }
            WM_EXITSIZEMOVE => {
                UI.lock().unwrap().in_drag = false;
                settle_after_drag(hwnd);
                0
            }
            WM_NCMOUSEMOVE => {
                on_hover(hwnd, true);
                DefWindowProcW(hwnd, msg, wparam, lparam)
            }
            WM_MOUSEMOVE => {
                on_hover(hwnd, false);
                0
            }
            WM_NCMOUSELEAVE | WM_MOUSELEAVE => {
                on_leave(hwnd);
                0
            }
            WM_LBUTTONUP => {
                let pt = POINT {
                    x: (lparam & 0xffff) as i16 as i32,
                    y: ((lparam >> 16) & 0xffff) as i16 as i32,
                };
                let hit = {
                    let ui = UI.lock().unwrap();
                    ui.buttons.iter().position(|rc| {
                        pt.x >= rc.left && pt.x < rc.right && pt.y >= rc.top && pt.y < rc.bottom
                    })
                };
                match hit {
                    Some(0) => focus_terminal(),
                    Some(1) => {
                        toggle_sound();
                        InvalidateRect(hwnd, std::ptr::null(), 0);
                    }
                    Some(2) => {
                        PostMessageW(hwnd, WM_CLOSE, 0, 0);
                    }
                    _ => {}
                }
                0
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

    // ── painting ─────────────────────────────────────────────────────────────

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

    unsafe fn make_font(c: &Ctx, size: i32, weight: i32) -> HGDIOBJ {
        let face = wide("Segoe UI");
        CreateFontW(
            -px(c, size),
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

    unsafe fn fill(dc: HDC, rc: &RECT, color: COLORREF) {
        let brush = CreateSolidBrush(color);
        FillRect(dc, rc, brush);
        DeleteObject(brush as HGDIOBJ);
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

    unsafe fn draw_goblin(dc: HDC, c: &Ctx, x: i32, y: i32, state: &State, frame: u8) {
        let grid: &[&str; 12] = if state.done {
            &GOBLIN_HAPPY
        } else if state.working && frame % 4 == 3 {
            &GOBLIN_BLINK
        } else {
            &GOBLIN_OPEN
        };
        let cell = px(c, 2).max(2);
        for (row, line) in grid.iter().enumerate() {
            for (col, ch) in line.chars().enumerate() {
                let color = match ch {
                    'G' => GREEN,
                    'D' => GREEN_DIM,
                    'B' => EYE,
                    'T' => GOLD,
                    'W' => WHITE,
                    _ => continue,
                };
                let rc = RECT {
                    left: x + (col as i32) * cell,
                    top: y + (row as i32) * cell,
                    right: x + (col as i32 + 1) * cell,
                    bottom: y + (row as i32 + 1) * cell,
                };
                fill(dc, &rc, color);
            }
        }
    }

    unsafe fn paint(hwnd: HWND) {
        let c = ctx();
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

        let (mode, edge, pulse, frame, flash, hovering) = {
            let ui = UI.lock().unwrap();
            (ui.mode, ui.edge, ui.pulse, ui.frame, ui.flash, ui.hovering)
        };

        let guard = STATE.lock().unwrap();
        let placeholder = State {
            title: "CodeGoblin".into(),
            status: "waiting for the goblin…".into(),
            ..Default::default()
        };
        let state = guard.as_ref().unwrap_or(&placeholder);

        if mode == Mode::DockedTab {
            // Small grey tab hugging the edge, with a status strip on the
            // inner side so working/done state stays glanceable.
            fill(mem, &rc, TAB_BG);
            let strip_color = if state.working {
                if pulse { GREEN } else { GREEN_DIM }
            } else if state.done {
                GOLD
            } else {
                EDGE_C
            };
            let t = px(&c, 3);
            let strip = match edge {
                Edge::Top => RECT { left: rc.left, top: rc.bottom - t, right: rc.right, bottom: rc.bottom },
                Edge::Left => RECT { left: rc.right - t, top: rc.top, right: rc.right, bottom: rc.bottom },
                Edge::Right => RECT { left: rc.left, top: rc.top, right: rc.left + t, bottom: rc.bottom },
            };
            fill(mem, &strip, strip_color);
        } else {
            fill(mem, &rc, BG);

            // Border: green flash right after a run finishes, hairline otherwise.
            let border = if flash > 0 && flash % 2 == 0 { GREEN } else { EDGE_C };
            let edge_brush = CreateSolidBrush(border);
            FrameRect(mem, &rc, edge_brush);
            DeleteObject(edge_brush as HGDIOBJ);

            let pad = px(&c, 10);

            // Mascot column.
            let sprite_w = px(&c, 2).max(2) * 14;
            draw_goblin(mem, &c, pad, px(&c, 16), state, frame);

            let text_x = pad + sprite_w + px(&c, 8);
            let title_font = make_font(&c, 14, 600);
            let body_font = make_font(&c, 12, 400);

            // Row 1: title + spend (right, gold).
            let mut spend_w = 0;
            if !state.spend.is_empty() {
                spend_w = px(&c, 64);
                let mut spend_rc = RECT {
                    left: w - pad - spend_w,
                    top: px(&c, 12),
                    right: w - pad,
                    bottom: px(&c, 30),
                };
                draw_text(mem, body_font, GOLD, &mut spend_rc, &state.spend, DT_RIGHT);
            }
            let mut title_rc = RECT {
                left: text_x,
                top: px(&c, 10),
                right: w - pad - spend_w - px(&c, 4),
                bottom: px(&c, 28),
            };
            let title = if state.title.is_empty() { "CodeGoblin" } else { &state.title };
            draw_text(mem, title_font, TITLE_FG, &mut title_rc, title, DT_LEFT | DT_END_ELLIPSIS);

            // Row 2: status + elapsed (right).
            let elapsed = elapsed_text(state);
            let mut elapsed_w = 0;
            if !elapsed.is_empty() {
                elapsed_w = px(&c, 56);
                let mut el_rc = RECT {
                    left: w - pad - elapsed_w,
                    top: px(&c, 32),
                    right: w - pad,
                    bottom: px(&c, 50),
                };
                draw_text(mem, body_font, STATUS_FG, &mut el_rc, &elapsed, DT_RIGHT);
            }
            let mut status_rc = RECT {
                left: text_x,
                top: px(&c, 32),
                right: w - pad - elapsed_w - px(&c, 4),
                bottom: px(&c, 50),
            };
            let status = if !state.status.is_empty() {
                state.status.as_str()
            } else if state.working {
                "goblin working…"
            } else {
                "idle"
            };
            let status_color = if state.done {
                GOLD
            } else if state.working {
                GREEN
            } else {
                STATUS_FG
            };
            draw_text(mem, body_font, status_color, &mut status_rc, status, DT_LEFT | DT_END_ELLIPSIS);

            // Menu row (hover only).
            let mut buttons = [ZERO_RECT; 3];
            if hovering {
                let menu_top = h - px(&c, MENU_H);
                let sep = RECT { left: 0, top: menu_top, right: w, bottom: menu_top + 1 };
                fill(mem, &sep, EDGE_C);
                let labels = [
                    "focus".to_string(),
                    if state.sound_enabled { "sound: on".to_string() } else { "sound: off".to_string() },
                    "hide".to_string(),
                ];
                let third = w / 3;
                for (i, label) in labels.iter().enumerate() {
                    let mut cell = RECT {
                        left: (i as i32) * third,
                        top: menu_top + 1,
                        right: ((i as i32) + 1) * third,
                        bottom: h,
                    };
                    buttons[i] = cell;
                    draw_text(mem, body_font, STATUS_FG, &mut cell, label, DT_CENTER | DT_VCENTER);
                }
            }
            UI.lock().unwrap().buttons = buttons;

            DeleteObject(title_font);
            DeleteObject(body_font);
        }

        drop(guard);

        BitBlt(hdc, 0, 0, w, h, mem, 0, 0, SRCCOPY);
        SelectObject(mem, old_bmp);
        DeleteObject(bmp as HGDIOBJ);
        DeleteDC(mem);

        EndPaint(hwnd, &ps);
    }
}
