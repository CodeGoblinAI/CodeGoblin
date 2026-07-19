//! `codegoblin-native widget` — a tiny always-on-top status bubble for Windows.
//!
//! Protocol v2: the TUI streams full JSON snapshots on stdin, one per line:
//!   {"sessions":[{"id":"ses_1","title":"fix auth","working":true,"status":"bash",
//!     "startedAtMs":123,"spend":"$0.42","ctx":"18.8K · 9%","todoDone":3,"todoTotal":7}],
//!    "question":{"requestID":"q1","sessionID":"ses_1","text":"Deploy target?",
//!     "options":["Production","Staging"]},
//!    "sound":true,"soundPath":null,"layout":{...},"chime":"done"}
//! `sessions`/`question` fully replace previous state each line; `sound`,
//! `soundPath`, and `layout` apply only when present (sent once at startup);
//! `chime` is a one-shot play request ("done" | "error"). When stdin closes
//! (TUI exit), the widget exits. No network, no discovery.
//!
//! The widget reports user actions as JSON lines on stdout:
//!   {"event":"sound","enabled":false}
//!   {"event":"layout","mode":"floating","x":12,"y":40}
//!   {"event":"layout","mode":"docked","edge":"right","along":420}
//!   {"event":"interrupt","sessionID":"ses_1"}
//!   {"event":"answer","requestID":"q1","option":"Staging"}
//!
//! Interactions:
//!   - drag anywhere to move; drop near the top/left/right monitor edge to
//!     dock it as a small tab (PC-Manager style); hover the tab to fly out
//!   - hover shows a menu row: focus / esc (interrupt) / sound / hide
//!   - question options render as clickable buttons
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
    use std::sync::{Mutex, OnceLock};
    use std::time::{SystemTime, UNIX_EPOCH};

    use windows_sys::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
    use windows_sys::Win32::Graphics::Dwm::DwmSetWindowAttribute;
    use windows_sys::Win32::Graphics::Gdi::*;
    use windows_sys::Win32::Media::Audio::{
        PlaySoundW, SND_ASYNC, SND_FILENAME, SND_MEMORY, SND_NODEFAULT,
    };
    use windows_sys::Win32::System::Console::GetConsoleWindow;
    use windows_sys::Win32::UI::HiDpi::{
        SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
    };
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        TrackMouseEvent, TME_LEAVE, TME_NONCLIENT, TRACKMOUSEEVENT,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::*;

    // Lives in the Win32_UI_Controls feature; not worth pulling that in for one constant.
    const WM_MOUSELEAVE: u32 = 0x02a3;

    // ── wire types ───────────────────────────────────────────────────────────

    #[derive(Clone, Default, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Row {
        #[serde(default)]
        id: String,
        #[serde(default)]
        title: String,
        #[serde(default)]
        status: String,
        #[serde(default)]
        working: bool,
        #[serde(default)]
        done: bool,
        #[serde(default)]
        error: bool,
        started_at_ms: Option<u64>,
        done_at_ms: Option<u64>,
        spend: Option<String>,
        ctx: Option<String>,
        todo_done: Option<u32>,
        todo_total: Option<u32>,
    }

    #[derive(Clone, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Question {
        #[serde(rename = "requestID")]
        request_id: String,
        #[serde(rename = "sessionID", default)]
        _session_id: String,
        text: String,
        #[serde(default)]
        options: Vec<String>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct LayoutIn {
        mode: String,
        edge: Option<String>,
        along: Option<i32>,
        x: Option<i32>,
        y: Option<i32>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Snapshot {
        sessions: Option<Vec<Row>>,
        question: Option<Question>,
        sound: Option<bool>,
        sound_path: Option<String>,
        layout: Option<LayoutIn>,
        chime: Option<String>,
    }

    struct State {
        rows: Vec<Row>,
        question: Option<Question>,
        sound_enabled: bool,
        sound_path: Option<String>,
    }

    impl Default for State {
        fn default() -> Self {
            Self { rows: Vec::new(), question: None, sound_enabled: true, sound_path: None }
        }
    }

    // ── ui state ─────────────────────────────────────────────────────────────

    #[derive(Clone, Copy, PartialEq)]
    enum Edge {
        Top,
        Left,
        Right,
    }

    impl Edge {
        fn name(self) -> &'static str {
            match self {
                Edge::Top => "top",
                Edge::Left => "left",
                Edge::Right => "right",
            }
        }
        fn parse(s: &str) -> Edge {
            match s {
                "left" => Edge::Left,
                "right" => Edge::Right,
                _ => Edge::Top,
            }
        }
    }

    #[derive(Clone, Copy, PartialEq)]
    enum Mode {
        Floating,
        DockedTab,
        DockedExpanded,
    }

    struct Anim {
        from: RECT,
        to: RECT,
        start: u64,
        dur: u32,
        /// When true, switch to the tab presentation once the slide lands.
        collapse: bool,
    }

    struct Hit {
        rect: RECT,
        action: Action,
    }

    #[derive(Clone, PartialEq)]
    enum Action {
        Focus,
        Interrupt(String),
        Sound,
        Hide,
        Answer(String, String), // requestID, option label
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
        /// Clickable regions (client coords), rebuilt at paint.
        hits: Vec<Hit>,
        anim: Option<Anim>,
        desired_h: i32,
    }

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
        hits: Vec::new(),
        anim: None,
        desired_h: 0,
    });
    static CTX: Mutex<Option<(isize, f32)>> = Mutex::new(None);

    const WM_APP_UPDATE: u32 = WM_APP + 1;
    const WM_APP_DONE: u32 = WM_APP + 2;
    const TIMER_TICK: usize = 1;
    const TIMER_ANIM: usize = 2;
    const ANIM_MS: u32 = 140;

    // 96-dpi layout constants (multiplied by the dpi scale at runtime).
    const BUBBLE_W: i32 = 330;
    const MENU_H: i32 = 24;
    const TAB_LEN: i32 = 56;
    const TAB_THICK: i32 = 12;
    const SNAP: i32 = 16;
    const PAD: i32 = 10;
    const STRIPE_W: i32 = 3;
    const EXTRA_ROW_H: i32 = 20;
    const META_ROW_H: i32 = 16;
    const QUESTION_TEXT_H: i32 = 32;
    const QUESTION_BTN_H: i32 = 22;
    const PRIMARY_H: i32 = 44;

    const BG: COLORREF = rgb(0x16, 0x18, 0x1c);
    const BG_RAISED: COLORREF = rgb(0x1c, 0x1f, 0x24);
    const EDGE_C: COLORREF = rgb(0x2a, 0x2d, 0x33);
    const TAB_BG: COLORREF = rgb(0x3a, 0x3d, 0x44);
    const TITLE_FG: COLORREF = rgb(0xe8, 0xe8, 0xe8);
    const STATUS_FG: COLORREF = rgb(0x9a, 0x9f, 0xa6);
    const FAINT_FG: COLORREF = rgb(0x6b, 0x70, 0x78);
    const GREEN: COLORREF = rgb(0x9a, 0xdb, 0x35);
    const GREEN_DIM: COLORREF = rgb(0x4f, 0x70, 0x1e);
    const GOLD: COLORREF = rgb(0xd4, 0xb0, 0x6a);
    const RED: COLORREF = rgb(0xd4, 0x6a, 0x6a);
    const EYE: COLORREF = rgb(0x10, 0x12, 0x14);
    const WHITE: COLORREF = rgb(0xff, 0xff, 0xff);

    const fn rgb(r: u8, g: u8, b: u8) -> COLORREF {
        (r as u32) | ((g as u32) << 8) | ((b as u32) << 16)
    }

    // ── goblin mascot ────────────────────────────────────────────────────────
    // The brand mask, sampled from codegoblin-logo.png into a 52x38 coverage
    // grid (hex 0-f = edge coverage). Rendered as a smoothed mini-bitmap via
    // StretchDIBits, so edges antialias against the bubble background instead
    // of reading as chunky pixel art.

    const SPRITE_W: i32 = 52;
    const SPRITE_H: i32 = 38;

    const GOBLIN_COVERAGE: [&str; 38] = [
        "000000000000000008fffffffffffffff8000000000000000000",
        "00000000000000002ffffffffffffffffd000000000000000000",
        "00000000000000008fffffffffffffffff700000000000000000",
        "0000000000000558dffffffffffffffffff75200000000000000",
        "0000000028affffffffffffffffffffffffffffaa53000000000",
        "00000000affffffffffffffffffffffffffffffffff300000000",
        "00000000affffffffffffffffffffffffffffffffff500000000",
        "a3000000affffffffffffffffffffffffffffffffff500000000",
        "ffc300008ffffffffffffffffffffffffffffffffff50000028d",
        "afffd5005ffffffffffffffffffffffffffffffffff500028ffc",
        "5fffffd75ffffffffffffffffffffffffffffffffff3028ffff7",
        "0ffffffffffffffffffffffffffffffffffffffffff3affffff0",
        "0affffffffffffffffffffffffffffffffffffffffffffffffa0",
        "05ffffffffffffffffffffffffffffffffffffffffffffffff30",
        "00fffffffffffffffffffffffffffffffffffffffffffffffd00",
        "008ffffffffffffffffffffffffffffffffffffffffffffff800",
        "002dfffffffffffffffffffffffffffffffffffffffffffff200",
        "0002cfffffffffff70555aadfffffffffffffffffffffffd2000",
        "000008ffffffffff50000000affffffffc0007ffffffffa20000",
        "0000005fffffffff50000000affffffffa0005fffffffa000000",
        "00000003dfffffffa00000005ffffffffa0007ffffff50000000",
        "000000000affffffa00000005ffffffffa000affffd500000000",
        "0000000005ffffffa00000005ffffffffa000affff7000000000",
        "0000000002ffffffd00000005ffffffffa000affff5000000000",
        "0000000000fffffff00000005ffffffffa000affff5000000000",
        "0000000000fffffff00000005ffffffffa025fffff3000000000",
        "0000000000fffffffc8555307fffffffffffffffff0000000000",
        "00000000008ffffffffffffffffffffffffffffffa0000000000",
        "000000000005ffffffffffffffffffffffffffff700000000000",
        "0000000000002affffffffffffffffffffffffd2000000000000",
        "000000000000005dfffffffffffffffffffff800000000000000",
        "0000000000000002afffffffffffffffffff3000000000000000",
        "00000000000000002ffffffffffffffffff80000000000000000",
        "000000000000000007fffffffffffffffff20000000000000000",
        "000000000000000002ffffffffffffffffc00000000000000000",
        "000000000000000000afffffffffffffff300000000000000000",
        "0000000000000000002dfffffffffffffd000000000000000000",
        "00000000000000000000002555aaacfff7000000000000000000",
    ];

    /// Blend `fg` over `bg` (both COLORREF 0x00BBGGRR) into a DIB 0x00RRGGBB.
    fn blend_dib(bg: COLORREF, fg: COLORREF, alpha: f32) -> u32 {
        let mix = |b: u32, f: u32| -> u32 {
            ((b as f32) + ((f as f32) - (b as f32)) * alpha).round() as u32
        };
        let r = mix(bg & 0xff, fg & 0xff);
        let g = mix((bg >> 8) & 0xff, (fg >> 8) & 0xff);
        let b = mix((bg >> 16) & 0xff, (fg >> 16) & 0xff);
        (r << 16) | (g << 8) | b
    }

    /// Eye cutout cells with hole depth: cells below full coverage that sit
    /// strictly between skin on both sides, within the eye band of the face.
    fn eye_mask() -> &'static Vec<(usize, usize, f32)> {
        static MASK: OnceLock<Vec<(usize, usize, f32)>> = OnceLock::new();
        MASK.get_or_init(|| {
            let mut cells = Vec::new();
            for (row, line) in GOBLIN_COVERAGE.iter().enumerate() {
                if !(17..=26).contains(&row) {
                    continue;
                }
                let cov: Vec<u32> = line.chars().map(|ch| ch.to_digit(16).unwrap_or(0)).collect();
                let first = cov.iter().position(|&v| v >= 8);
                let last = cov.iter().rposition(|&v| v >= 8);
                if let (Some(first), Some(last)) = (first, last) {
                    for col in first..=last {
                        if cov[col] < 8 {
                            let depth = 1.0 - (cov[col] as f32 / 8.0);
                            cells.push((row, col, depth));
                        }
                    }
                }
            }
            cells
        })
    }

    /// Blend `fg` (COLORREF) over an existing DIB pixel by `alpha`.
    fn blend_over(base: u32, fg: COLORREF, alpha: f32) -> u32 {
        let mix = |b: u32, f: u32| -> u32 {
            ((b as f32) + ((f as f32) - (b as f32)) * alpha).round() as u32
        };
        let r = mix((base >> 16) & 0xff, fg & 0xff);
        let g = mix((base >> 8) & 0xff, (fg >> 8) & 0xff);
        let b = mix(base & 0xff, (fg >> 16) & 0xff);
        (r << 16) | (g << 8) | b
    }

    fn build_sprite(variant: u8) -> Vec<u32> {
        let mut pixels = vec![0u32; (SPRITE_W * SPRITE_H) as usize];
        for (row, line) in GOBLIN_COVERAGE.iter().enumerate() {
            for (col, ch) in line.chars().enumerate() {
                let cov = ch.to_digit(16).unwrap_or(0) as f32 / 15.0;
                pixels[row * SPRITE_W as usize + col] = blend_dib(BG, GREEN, cov);
            }
        }
        for &(row, col, depth) in eye_mask() {
            let idx = row * SPRITE_W as usize + col;
            let base = pixels[idx];
            pixels[idx] = match variant {
                // blink: eyes closed — skin with a dim lid line mid-eye
                1 => {
                    if (21..=22).contains(&row) {
                        blend_over(base, GREEN_DIM, depth)
                    } else {
                        blend_over(base, GREEN, depth)
                    }
                }
                // open + happy keep the mask's dark cutouts; "done" is
                // signalled by the sparkle and the gold accents around it
                _ => blend_over(base, EYE, depth),
            };
        }
        if variant == 2 {
            // A little sparkle off the crest.
            for &(row, col) in &[(1usize, 45usize), (2, 44), (2, 45), (2, 46), (3, 45)] {
                pixels[row * SPRITE_W as usize + col] = blend_dib(BG, WHITE, 1.0);
            }
        }
        pixels
    }

    fn sprite(variant: u8) -> &'static Vec<u32> {
        static SPRITES: OnceLock<[Vec<u32>; 3]> = OnceLock::new();
        &SPRITES.get_or_init(|| [build_sprite(0), build_sprite(1), build_sprite(2)])[variant as usize]
    }

    // ── helpers ──────────────────────────────────────────────────────────────

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

    fn px(c: &Ctx, v: i32) -> i32 {
        ((v as f32) * c.scale).round() as i32
    }

    fn emit_stdout(line: &str) {
        use std::io::Write;
        let mut out = std::io::stdout();
        let _ = out.write_all(line.as_bytes());
        let _ = out.write_all(b"\n");
        let _ = out.flush();
    }

    fn json_escape(s: &str) -> String {
        s.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', "\\n")
    }

    fn fmt_dur(secs: u64) -> String {
        if secs >= 60 {
            format!("{}m{:02}s", secs / 60, secs % 60)
        } else {
            format!("{}s", secs)
        }
    }

    fn fmt_ago(ms: u64) -> String {
        let secs = now_ms().saturating_sub(ms) / 1000;
        if secs < 60 {
            "just now".into()
        } else if secs < 3600 {
            format!("{}m ago", secs / 60)
        } else {
            format!("{}h ago", secs / 3600)
        }
    }

    // ── chimes ───────────────────────────────────────────────────────────────
    // Little synthesized goblin chimes (soft chiptune: sine + a whisper of
    // square), rendered once into in-memory WAVs and played with SND_MEMORY.

    const SAMPLE_RATE: u32 = 22050;

    fn synth_chime(notes: &[(f32, f32)]) -> Vec<u8> {
        let mut samples: Vec<i16> = Vec::new();
        for &(freq, dur) in notes {
            let count = (dur * SAMPLE_RATE as f32) as usize;
            for i in 0..count {
                let t = i as f32 / SAMPLE_RATE as f32;
                let phase = 2.0 * std::f32::consts::PI * freq * t;
                let sine = phase.sin();
                let square = if sine >= 0.0 { 1.0 } else { -1.0 };
                let envelope = (-t * 9.0).exp() * (1.0 - (i as f32 / count as f32)).max(0.0);
                let value = (0.72 * sine + 0.28 * square) * envelope * 0.30;
                samples.push((value * i16::MAX as f32) as i16);
            }
        }
        let data_len = (samples.len() * 2) as u32;
        let mut wav = Vec::with_capacity(44 + data_len as usize);
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(36 + data_len).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
        wav.extend_from_slice(&(SAMPLE_RATE * 2).to_le_bytes());
        wav.extend_from_slice(&2u16.to_le_bytes());
        wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&data_len.to_le_bytes());
        for sample in samples {
            wav.extend_from_slice(&sample.to_le_bytes());
        }
        wav
    }

    fn done_chime() -> &'static [u8] {
        static CHIME: OnceLock<Vec<u8>> = OnceLock::new();
        // A bright little rising "dig complete": G5 → D6 → G6.
        CHIME.get_or_init(|| synth_chime(&[(784.0, 0.11), (1175.0, 0.11), (1568.0, 0.22)]))
    }

    fn error_chime() -> &'static [u8] {
        static CHIME: OnceLock<Vec<u8>> = OnceLock::new();
        // A low descending "uh-oh": D4 → G3.
        CHIME.get_or_init(|| synth_chime(&[(294.0, 0.16), (196.0, 0.26)]))
    }

    fn play_chime(error: bool) {
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
            if !error {
                if let Some(path) = path {
                    let w = wide(&path);
                    if PlaySoundW(w.as_ptr(), std::ptr::null_mut(), SND_ASYNC | SND_FILENAME | SND_NODEFAULT) != 0
                    {
                        return;
                    }
                }
            }
            let chime = if error { error_chime() } else { done_chime() };
            PlaySoundW(chime.as_ptr() as *const u16, std::ptr::null_mut(), SND_ASYNC | SND_MEMORY | SND_NODEFAULT);
        }
    }

    // ── layout math ──────────────────────────────────────────────────────────

    fn desired_height(c: &Ctx) -> i32 {
        let guard = STATE.lock().unwrap();
        let (extras, has_meta, question_btns, has_question) = match guard.as_ref() {
            Some(s) => {
                let extras = s.rows.len().saturating_sub(1).min(3) as i32;
                let has_meta = s
                    .rows
                    .first()
                    .map(|r| r.ctx.is_some() || r.todo_total.unwrap_or(0) > 0)
                    .unwrap_or(false);
                let btns = s.question.as_ref().map(|q| !q.options.is_empty()).unwrap_or(false);
                (extras, has_meta, btns, s.question.is_some())
            }
            None => (0, false, false, false),
        };
        let mut h = PAD + PRIMARY_H;
        if has_meta {
            h += META_ROW_H;
        }
        h += extras * EXTRA_ROW_H;
        if has_question {
            h += QUESTION_TEXT_H;
            if question_btns {
                h += QUESTION_BTN_H + 4;
            }
        }
        h += MENU_H;
        px(c, h)
    }

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

    fn expanded_rect(c: &Ctx, mon: &RECT, edge: Edge, along: i32, h: i32) -> (i32, i32, i32, i32) {
        let w = px(c, BUBBLE_W);
        match edge {
            Edge::Top => (along.clamp(mon.left, mon.right - w), mon.top, w, h),
            Edge::Left => (mon.left, along.clamp(mon.top, mon.bottom - h), w, h),
            Edge::Right => (mon.right - w, along.clamp(mon.top, mon.bottom - h), w, h),
        }
    }

    /// Apply a new desired height after a snapshot; keeps the bottom edge
    /// anchored when the bubble sits in the lower half of the screen.
    fn apply_height(hwnd: HWND) {
        let c = ctx();
        let h = desired_height(&c);
        let (mode, edge, along) = {
            let mut ui = UI.lock().unwrap();
            ui.desired_h = h;
            (ui.mode, ui.edge, ui.along)
        };
        match mode {
            Mode::Floating => {
                let rc = window_rect(hwnd);
                let cur_h = rc.bottom - rc.top;
                if cur_h == h {
                    return;
                }
                let mon = monitor_rect(hwnd);
                let mid = (mon.top + mon.bottom) / 2;
                let y = if rc.top > mid { rc.bottom - h } else { rc.top };
                set_rect(hwnd, rc.left, y, px(&c, BUBBLE_W), h);
            }
            Mode::DockedExpanded => {
                let mon = monitor_rect(hwnd);
                let (x, y, w, hh) = expanded_rect(&c, &mon, edge, along, h);
                set_rect(hwnd, x, y, w, hh);
            }
            Mode::DockedTab => {}
        }
    }

    // ── animation ────────────────────────────────────────────────────────────

    fn start_anim(hwnd: HWND, to: (i32, i32, i32, i32), collapse: bool) {
        let from = window_rect(hwnd);
        {
            let mut ui = UI.lock().unwrap();
            ui.anim = Some(Anim {
                from,
                to: RECT { left: to.0, top: to.1, right: to.0 + to.2, bottom: to.1 + to.3 },
                start: now_ms(),
                dur: ANIM_MS,
                collapse,
            });
        }
        unsafe {
            SetTimer(hwnd, TIMER_ANIM, 10, None);
        }
    }

    fn step_anim(hwnd: HWND) {
        let step = {
            let mut ui = UI.lock().unwrap();
            let Some(anim) = ui.anim.as_ref() else {
                return;
            };
            let p = ((now_ms().saturating_sub(anim.start)) as f32 / anim.dur as f32).min(1.0);
            let ease = 1.0 - (1.0 - p).powi(3);
            let lerp = |a: i32, b: i32| a + (((b - a) as f32) * ease).round() as i32;
            let rect = (
                lerp(anim.from.left, anim.to.left),
                lerp(anim.from.top, anim.to.top),
                lerp(anim.from.right - anim.from.left, anim.to.right - anim.to.left),
                lerp(anim.from.bottom - anim.from.top, anim.to.bottom - anim.to.top),
            );
            let finished = p >= 1.0;
            if finished {
                let collapse = anim.collapse;
                ui.anim = None;
                if collapse {
                    ui.mode = Mode::DockedTab;
                }
            }
            (rect, finished)
        };
        let ((x, y, w, h), finished) = step;
        set_rect(hwnd, x, y, w, h);
        unsafe {
            if finished {
                KillTimer(hwnd, TIMER_ANIM);
            }
            InvalidateRect(hwnd, std::ptr::null(), 0);
        }
    }

    // ── dock / drag ──────────────────────────────────────────────────────────

    fn emit_layout(hwnd: HWND) {
        let ui = UI.lock().unwrap();
        match ui.mode {
            Mode::Floating => {
                drop(ui);
                let rc = window_rect(hwnd);
                emit_stdout(&format!(
                    "{{\"event\":\"layout\",\"mode\":\"floating\",\"x\":{},\"y\":{}}}",
                    rc.left, rc.top
                ));
            }
            Mode::DockedTab | Mode::DockedExpanded => {
                emit_stdout(&format!(
                    "{{\"event\":\"layout\",\"mode\":\"docked\",\"edge\":\"{}\",\"along\":{}}}",
                    ui.edge.name(),
                    ui.along
                ));
            }
        }
    }

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
                let target = expanded_rect(&c, &mon, edge, ui.along, ui.desired_h.max(px(&c, 60)));
                drop(ui);
                start_anim(hwnd, target, false);
            }
            None => {
                ui.mode = Mode::Floating;
                ui.anim = None;
                let h = ui.desired_h.max(px(&c, 60));
                drop(ui);
                set_rect(hwnd, rc.left, rc.top, px(&c, BUBBLE_W), h);
            }
        }
        unsafe { InvalidateRect(hwnd, std::ptr::null(), 0) };
        emit_layout(hwnd);
    }

    fn expand_from_tab(hwnd: HWND) {
        let c = ctx();
        let mon = monitor_rect(hwnd);
        let mut ui = UI.lock().unwrap();
        let collapsing = ui.anim.as_ref().map(|a| a.collapse).unwrap_or(false);
        if ui.mode != Mode::DockedTab && !collapsing {
            return;
        }
        ui.mode = Mode::DockedExpanded;
        ui.anim = None;
        let target = expanded_rect(&c, &mon, ui.edge, ui.along, ui.desired_h.max(px(&c, 60)));
        drop(ui);
        start_anim(hwnd, target, false);
    }

    fn collapse_to_tab(hwnd: HWND) {
        let c = ctx();
        let mon = monitor_rect(hwnd);
        let ui = UI.lock().unwrap();
        if ui.mode != Mode::DockedExpanded || ui.in_drag {
            return;
        }
        if ui.anim.as_ref().map(|a| a.collapse).unwrap_or(false) {
            return;
        }
        let target = tab_rect(&c, &mon, ui.edge, ui.along);
        drop(ui);
        start_anim(hwnd, target, true);
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

    fn toggle_sound() {
        let mut guard = STATE.lock().unwrap();
        let state = guard.get_or_insert_with(State::default);
        state.sound_enabled = !state.sound_enabled;
        let enabled = state.sound_enabled;
        drop(guard);
        emit_stdout(&format!("{{\"event\":\"sound\",\"enabled\":{enabled}}}"));
    }

    // ── stdin reader ─────────────────────────────────────────────────────────

    fn apply_initial_layout(hwnd: HWND, layout: &LayoutIn) {
        let c = ctx();
        if layout.mode == "docked" {
            let edge = Edge::parse(layout.edge.as_deref().unwrap_or("top"));
            let along = layout.along.unwrap_or(0);
            {
                let mut ui = UI.lock().unwrap();
                ui.mode = Mode::DockedTab;
                ui.edge = edge;
                ui.along = along;
            }
            let mon = monitor_rect(hwnd);
            let (x, y, w, h) = tab_rect(&c, &mon, edge, along);
            set_rect(hwnd, x, y, w, h);
        } else if let (Some(x), Some(y)) = (layout.x, layout.y) {
            let mon = monitor_rect(hwnd);
            let w = px(&c, BUBBLE_W);
            let h = { UI.lock().unwrap().desired_h.max(px(&c, 60)) };
            let x = x.clamp(mon.left, (mon.right - w).max(mon.left));
            let y = y.clamp(mon.top, (mon.bottom - h).max(mon.top));
            set_rect(hwnd, x, y, w, h);
        }
        unsafe { InvalidateRect(hwnd, std::ptr::null(), 0) };
    }

    fn spawn_stdin_reader(hwnd: isize) {
        std::thread::spawn(move || {
            let stdin = std::io::stdin();
            let mut layout_applied = false;
            for line in stdin.lock().lines() {
                let Ok(line) = line else { break };
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let Ok(snapshot) = serde_json::from_str::<Snapshot>(trimmed) else {
                    continue;
                };
                let chime = snapshot.chime.clone();
                {
                    let mut guard = STATE.lock().unwrap();
                    let state = guard.get_or_insert_with(State::default);
                    if let Some(rows) = snapshot.sessions {
                        state.rows = rows;
                        state.question = snapshot.question;
                    } else if snapshot.question.is_some() {
                        state.question = snapshot.question;
                    }
                    if let Some(v) = snapshot.sound {
                        state.sound_enabled = v;
                    }
                    if snapshot.sound_path.is_some() {
                        state.sound_path = snapshot.sound_path;
                    }
                }
                if let Some(layout) = snapshot.layout {
                    if !layout_applied {
                        layout_applied = true;
                        apply_initial_layout(hwnd as HWND, &layout);
                    }
                }
                let msg = if chime.is_some() { WM_APP_DONE } else { WM_APP_UPDATE };
                unsafe {
                    PostMessageW(hwnd as HWND, msg, 0, 0);
                }
                if let Some(chime) = chime {
                    play_chime(chime == "error");
                }
            }
            unsafe {
                PostMessageW(hwnd as HWND, WM_CLOSE, 0, 0);
            }
        });
    }

    // ── window proc ──────────────────────────────────────────────────────────

    unsafe extern "system" fn wnd_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        match msg {
            WM_APP_UPDATE => {
                apply_height(hwnd);
                InvalidateRect(hwnd, std::ptr::null(), 0);
                0
            }
            WM_APP_DONE => {
                {
                    let mut ui = UI.lock().unwrap();
                    ui.flash = 6;
                }
                apply_height(hwnd);
                InvalidateRect(hwnd, std::ptr::null(), 0);
                0
            }
            WM_TIMER if wparam == TIMER_ANIM => {
                step_anim(hwnd);
                0
            }
            WM_TIMER => {
                let mut repaint = false;
                {
                    let mut ui = UI.lock().unwrap();
                    let (any_working, any_done) = {
                        let guard = STATE.lock().unwrap();
                        match guard.as_ref() {
                            Some(s) => (
                                s.rows.iter().any(|r| r.working),
                                s.rows.iter().any(|r| r.done_at_ms.is_some()),
                            ),
                            None => (false, false),
                        }
                    };
                    if any_working {
                        ui.pulse = !ui.pulse;
                        ui.frame = ui.frame.wrapping_add(1);
                        repaint = true;
                    } else if any_done {
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
                let ui = UI.lock().unwrap();
                if ui.mode != Mode::DockedTab {
                    let mut pt = POINT {
                        x: (lparam & 0xffff) as i16 as i32,
                        y: ((lparam >> 16) & 0xffff) as i16 as i32,
                    };
                    ScreenToClient(hwnd, &mut pt);
                    if ui
                        .hits
                        .iter()
                        .any(|h| pt.x >= h.rect.left && pt.x < h.rect.right && pt.y >= h.rect.top && pt.y < h.rect.bottom)
                    {
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
                let action = {
                    let ui = UI.lock().unwrap();
                    ui.hits
                        .iter()
                        .find(|h| pt.x >= h.rect.left && pt.x < h.rect.right && pt.y >= h.rect.top && pt.y < h.rect.bottom)
                        .map(|h| h.action.clone())
                };
                match action {
                    Some(Action::Focus) => focus_terminal(),
                    Some(Action::Interrupt(session)) => {
                        emit_stdout(&format!(
                            "{{\"event\":\"interrupt\",\"sessionID\":\"{}\"}}",
                            json_escape(&session)
                        ));
                    }
                    Some(Action::Sound) => {
                        toggle_sound();
                        InvalidateRect(hwnd, std::ptr::null(), 0);
                    }
                    Some(Action::Hide) => {
                        PostMessageW(hwnd, WM_CLOSE, 0, 0);
                    }
                    Some(Action::Answer(request, option)) => {
                        emit_stdout(&format!(
                            "{{\"event\":\"answer\",\"requestID\":\"{}\",\"option\":\"{}\"}}",
                            json_escape(&request),
                            json_escape(&option)
                        ));
                    }
                    None => {}
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
        DrawTextW(dc, buf.as_mut_ptr(), buf.len() as i32, rect, flags | DT_NOPREFIX);
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

    unsafe fn draw_goblin(dc: HDC, c: &Ctx, x: i32, y: i32, working: bool, done: bool, frame: u8) {
        let variant = if done {
            2
        } else if working && frame % 4 == 3 {
            1
        } else {
            0
        };
        let pixels = sprite(variant);
        let mut bmi: BITMAPINFO = std::mem::zeroed();
        bmi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        bmi.bmiHeader.biWidth = SPRITE_W;
        bmi.bmiHeader.biHeight = -SPRITE_H; // top-down
        bmi.bmiHeader.biPlanes = 1;
        bmi.bmiHeader.biBitCount = 32;
        bmi.bmiHeader.biCompression = BI_RGB as u32;
        let prev = SetStretchBltMode(dc, HALFTONE);
        SetBrushOrgEx(dc, 0, 0, std::ptr::null_mut());
        StretchDIBits(
            dc,
            x,
            y,
            px(c, SPRITE_W),
            px(c, SPRITE_H),
            0,
            0,
            SPRITE_W,
            SPRITE_H,
            pixels.as_ptr() as *const _,
            &bmi,
            DIB_RGB_COLORS,
            SRCCOPY,
        );
        SetStretchBltMode(dc, prev);
    }

    unsafe fn paint(hwnd: HWND) {
        let c = ctx();
        let mut ps: PAINTSTRUCT = std::mem::zeroed();
        let hdc = BeginPaint(hwnd, &mut ps);

        let mut rc: RECT = std::mem::zeroed();
        GetClientRect(hwnd, &mut rc);
        let w = rc.right - rc.left;
        let h = rc.bottom - rc.top;

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
            rows: vec![Row {
                title: "CodeGoblin".into(),
                status: "waiting for the goblin…".into(),
                ..Default::default()
            }],
            ..Default::default()
        };
        let state = match guard.as_ref() {
            Some(s) if !s.rows.is_empty() => s,
            _ => &placeholder,
        };
        let primary = &state.rows[0];
        let mut hits: Vec<Hit> = Vec::new();

        if mode == Mode::DockedTab {
            fill(mem, &rc, TAB_BG);
            let strip_color = if primary.working {
                if pulse { GREEN } else { GREEN_DIM }
            } else if primary.done {
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

            // Left accent stripe carries the primary state color.
            let stripe_color = if primary.error {
                RED
            } else if primary.working {
                if pulse { GREEN } else { GREEN_DIM }
            } else if primary.done {
                GOLD
            } else {
                EDGE_C
            };
            let stripe = RECT { left: 1, top: 1, right: 1 + px(&c, STRIPE_W), bottom: h - 1 };
            fill(mem, &stripe, stripe_color);

            let pad = px(&c, PAD);
            let title_font = make_font(&c, 14, 600);
            let body_font = make_font(&c, 12, 400);
            let small_font = make_font(&c, 10, 400);

            // Mascot column, centered against the primary block.
            let sprite_w = px(&c, SPRITE_W);
            let sprite_h = px(&c, SPRITE_H);
            let primary_block_h = px(&c, PRIMARY_H);
            let sprite_y = pad + (primary_block_h - sprite_h) / 2;
            draw_goblin(mem, &c, pad, sprite_y.max(pad / 2), primary.working, primary.done, frame);

            let text_x = pad + sprite_w + px(&c, 8);
            let mut y = pad;

            // ── primary session ──
            // Row 1: title + spend (gold, right).
            let mut right_w = 0;
            if let Some(spend) = primary.spend.as_ref().filter(|s| !s.is_empty()) {
                right_w = px(&c, 64);
                let mut spend_rc =
                    RECT { left: w - pad - right_w, top: y, right: w - pad, bottom: y + px(&c, 18) };
                draw_text(mem, body_font, GOLD, &mut spend_rc, spend, DT_RIGHT | DT_SINGLELINE);
            }
            let mut title_rc = RECT {
                left: text_x,
                top: y,
                right: w - pad - right_w - px(&c, 4),
                bottom: y + px(&c, 19),
            };
            let title = if primary.title.is_empty() { "CodeGoblin" } else { &primary.title };
            draw_text(mem, title_font, TITLE_FG, &mut title_rc, title, DT_LEFT | DT_SINGLELINE | DT_END_ELLIPSIS);
            y += px(&c, 20);

            // Row 2: status + elapsed / finished-ago (right).
            let right_text = if primary.working {
                primary
                    .started_at_ms
                    .map(|s| fmt_dur(now_ms().saturating_sub(s) / 1000))
                    .unwrap_or_default()
            } else if let Some(done_at) = primary.done_at_ms {
                fmt_ago(done_at)
            } else {
                String::new()
            };
            let mut elapsed_w = 0;
            if !right_text.is_empty() {
                elapsed_w = px(&c, 60);
                let mut el_rc =
                    RECT { left: w - pad - elapsed_w, top: y, right: w - pad, bottom: y + px(&c, 16) };
                draw_text(mem, body_font, STATUS_FG, &mut el_rc, &right_text, DT_RIGHT | DT_SINGLELINE);
            }
            let mut status_rc = RECT {
                left: text_x,
                top: y,
                right: w - pad - elapsed_w - px(&c, 4),
                bottom: y + px(&c, 16),
            };
            let status = if !primary.status.is_empty() {
                primary.status.as_str()
            } else if primary.working {
                "goblin working…"
            } else {
                "idle"
            };
            let status_color = if primary.error {
                RED
            } else if primary.done {
                GOLD
            } else if primary.working {
                GREEN
            } else {
                STATUS_FG
            };
            draw_text(mem, body_font, status_color, &mut status_rc, status, DT_LEFT | DT_SINGLELINE | DT_END_ELLIPSIS);
            y = pad + primary_block_h;

            // Meta row: todo progress bar + ctx readout.
            let has_meta = primary.ctx.is_some() || primary.todo_total.unwrap_or(0) > 0;
            if has_meta {
                if let (Some(done), Some(total)) = (primary.todo_done, primary.todo_total) {
                    if total > 0 {
                        let bar_w = px(&c, 70);
                        let bar_h = px(&c, 4);
                        let bar_y = y + px(&c, 6);
                        let track =
                            RECT { left: text_x, top: bar_y, right: text_x + bar_w, bottom: bar_y + bar_h };
                        fill(mem, &track, EDGE_C);
                        let fill_w = ((bar_w as f32) * (done.min(total) as f32 / total as f32)) as i32;
                        let done_rc = RECT {
                            left: text_x,
                            top: bar_y,
                            right: text_x + fill_w,
                            bottom: bar_y + bar_h,
                        };
                        fill(mem, &done_rc, GREEN);
                        let mut label_rc = RECT {
                            left: text_x + bar_w + px(&c, 6),
                            top: y,
                            right: text_x + bar_w + px(&c, 50),
                            bottom: y + px(&c, 15),
                        };
                        draw_text(
                            mem,
                            small_font,
                            FAINT_FG,
                            &mut label_rc,
                            &format!("{}/{}", done.min(total), total),
                            DT_LEFT | DT_SINGLELINE,
                        );
                    }
                }
                if let Some(ctx_text) = primary.ctx.as_ref().filter(|s| !s.is_empty()) {
                    let mut ctx_rc =
                        RECT { left: w / 2, top: y, right: w - pad, bottom: y + px(&c, 15) };
                    draw_text(mem, small_font, FAINT_FG, &mut ctx_rc, ctx_text, DT_RIGHT | DT_SINGLELINE);
                }
                y += px(&c, META_ROW_H);
            }

            // ── extra sessions (compact rows) ──
            for row in state.rows.iter().skip(1).take(3) {
                let dot_color = if row.error {
                    RED
                } else if row.working {
                    if pulse { GREEN } else { GREEN_DIM }
                } else if row.done {
                    GOLD
                } else {
                    EDGE_C
                };
                let dot = px(&c, 6);
                let dot_rc = RECT {
                    left: pad + px(&c, 4),
                    top: y + px(&c, 7),
                    right: pad + px(&c, 4) + dot,
                    bottom: y + px(&c, 7) + dot,
                };
                fill(mem, &dot_rc, dot_color);

                let right_text = if row.working {
                    row.started_at_ms
                        .map(|s| fmt_dur(now_ms().saturating_sub(s) / 1000))
                        .unwrap_or_default()
                } else if let Some(done_at) = row.done_at_ms {
                    fmt_ago(done_at)
                } else {
                    String::new()
                };
                let mut right_w = 0;
                if !right_text.is_empty() {
                    right_w = px(&c, 56);
                    let mut r =
                        RECT { left: w - pad - right_w, top: y + px(&c, 2), right: w - pad, bottom: y + px(&c, 17) };
                    draw_text(mem, small_font, FAINT_FG, &mut r, &right_text, DT_RIGHT | DT_SINGLELINE);
                }
                let label = if row.status.is_empty() {
                    row.title.clone()
                } else {
                    format!("{} — {}", row.title, row.status)
                };
                let mut r = RECT {
                    left: pad + px(&c, 16),
                    top: y + px(&c, 2),
                    right: w - pad - right_w - px(&c, 4),
                    bottom: y + px(&c, 17),
                };
                draw_text(mem, small_font, STATUS_FG, &mut r, &label, DT_LEFT | DT_SINGLELINE | DT_END_ELLIPSIS);
                y += px(&c, EXTRA_ROW_H);
            }

            // ── question preview ──
            if let Some(question) = state.question.as_ref() {
                let mut q_rc = RECT {
                    left: text_x,
                    top: y + px(&c, 2),
                    right: w - pad,
                    bottom: y + px(&c, QUESTION_TEXT_H),
                };
                let mut marker_rc =
                    RECT { left: pad + px(&c, 4), top: y + px(&c, 2), right: text_x, bottom: y + px(&c, 18) };
                draw_text(mem, title_font, GOLD, &mut marker_rc, "?", DT_LEFT | DT_SINGLELINE);
                draw_text(mem, body_font, TITLE_FG, &mut q_rc, &question.text, DT_LEFT | DT_WORDBREAK | DT_END_ELLIPSIS);
                y += px(&c, QUESTION_TEXT_H);

                if !question.options.is_empty() {
                    let count = question.options.len().min(3) as i32;
                    let gap = px(&c, 6);
                    let btn_w = (w - pad - text_x - gap * (count - 1)) / count;
                    let btn_h = px(&c, QUESTION_BTN_H);
                    for (i, option) in question.options.iter().take(3).enumerate() {
                        let left = text_x + (btn_w + gap) * (i as i32);
                        let btn = RECT { left, top: y, right: left + btn_w, bottom: y + btn_h };
                        fill(mem, &btn, BG_RAISED);
                        let frame_brush = CreateSolidBrush(GREEN_DIM);
                        FrameRect(mem, &btn, frame_brush);
                        DeleteObject(frame_brush as HGDIOBJ);
                        let mut label_rc = btn;
                        draw_text(
                            mem,
                            small_font,
                            TITLE_FG,
                            &mut label_rc,
                            option,
                            DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_END_ELLIPSIS,
                        );
                        hits.push(Hit {
                            rect: btn,
                            action: Action::Answer(question.request_id.clone(), option.clone()),
                        });
                    }
                    let _ = y; // menu row is bottom-anchored; nothing renders below the buttons
                }
            }

            // ── menu row (hover only) ──
            if hovering {
                let menu_top = h - px(&c, MENU_H);
                let sep = RECT { left: 1, top: menu_top, right: w - 1, bottom: menu_top + 1 };
                fill(mem, &sep, EDGE_C);

                let mut entries: Vec<(String, Action, COLORREF)> =
                    vec![("focus".into(), Action::Focus, STATUS_FG)];
                if primary.working && !primary.id.is_empty() {
                    entries.push(("esc".into(), Action::Interrupt(primary.id.clone()), RED));
                }
                entries.push((
                    if state.sound_enabled { "sound: on".into() } else { "sound: off".into() },
                    Action::Sound,
                    STATUS_FG,
                ));
                entries.push(("hide".into(), Action::Hide, STATUS_FG));

                let count = entries.len() as i32;
                let cell_w = (w - 2) / count;
                for (i, (label, action, color)) in entries.into_iter().enumerate() {
                    let left = 1 + cell_w * (i as i32);
                    let cell_rc = RECT { left, top: menu_top + 1, right: left + cell_w, bottom: h - 1 };
                    if i > 0 {
                        let div = RECT {
                            left,
                            top: menu_top + px(&c, 6),
                            right: left + 1,
                            bottom: h - px(&c, 6),
                        };
                        fill(mem, &div, EDGE_C);
                    }
                    let mut label_rc = cell_rc;
                    draw_text(
                        mem,
                        small_font,
                        color,
                        &mut label_rc,
                        &label,
                        DT_CENTER | DT_VCENTER | DT_SINGLELINE,
                    );
                    hits.push(Hit { rect: cell_rc, action });
                }
            }

            DeleteObject(title_font);
            DeleteObject(body_font);
            DeleteObject(small_font);
        }

        drop(guard);
        UI.lock().unwrap().hits = hits;

        BitBlt(hdc, 0, 0, w, h, mem, 0, 0, SRCCOPY);
        SelectObject(mem, old_bmp);
        DeleteObject(bmp as HGDIOBJ);
        DeleteDC(mem);

        EndPaint(hwnd, &ps);
    }

    // ── entry ────────────────────────────────────────────────────────────────

    pub fn run() -> Result<(), String> {
        unsafe {
            let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);

            // Whoever is foreground at launch is almost always the terminal the
            // user toggled the widget from; remember it for click-to-focus.
            let terminal = GetForegroundWindow();

            let instance = windows_sys::Win32::System::LibraryLoader::GetModuleHandleW(std::ptr::null());
            let class_name = wide("CodeGoblinWidget");
            let wc = WNDCLASSW {
                style: CS_HREDRAW | CS_VREDRAW | CS_DBLCLKS | CS_DROPSHADOW,
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
            let height = desired_height(&c);
            UI.lock().unwrap().desired_h = height;

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
}
