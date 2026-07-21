//! `codegoblin-native widget` — an always-on-top status island for Windows.
//!
//! Two visual states, vibeisland-style:
//!   - **Island**: a compact pill (mascot + session title + working-count
//!     badge) that stays out of the way.
//!   - **Panel**: click the island to expand a rich panel — account-usage
//!     header strip, one row per session, question preview with answer
//!     buttons, and a footer button row (focus / esc / sound / hide).
//!
//! Protocol v3: the TUI streams full JSON snapshots on stdin, one per line:
//!   {"sessions":[{"id":"ses_1","title":"fix auth","working":true,"status":"bash",
//!     "startedAtMs":123,"spend":"$0.42","ctx":"18.8K · 9%","todoDone":3,"todoTotal":7}],
//!    "usage":[{"label":"5h","pct":11,"reset":"4h1m"},{"label":"7d","pct":2,"reset":"6h1m"}],
//!    "question":{"requestID":"q1","sessionID":"ses_1","text":"Deploy target?",
//!     "options":["Production","Staging"]},
//!    "sound":true,"soundPath":null,"layout":{...},"chime":"done"}
//! `sessions`/`question`/`usage` fully replace previous state each line;
//! `sound`, `soundPath`, and `layout` apply only when present (sent once at
//! startup); `chime` is a one-shot play request ("done" | "error"). When stdin
//! closes (TUI exit), the widget exits. No network, no discovery.
//!
//! The widget reports user actions as JSON lines on stdout:
//!   {"event":"sound","enabled":false}
//!   {"event":"layout","mode":"floating","x":12,"y":40}
//!   {"event":"interrupt","sessionID":"ses_1"}
//!   {"event":"answer","requestID":"q1","option":"Staging"}
//!
//! Interactions: click the island to expand, click the panel header (or move
//! the mouse away) to collapse, drag anywhere to move, right-click to dismiss.

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
        ReleaseCapture, SetCapture, TrackMouseEvent, TME_LEAVE, TRACKMOUSEEVENT,
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
        prompt: Option<String>,
        model: Option<String>,
        todo_done: Option<u32>,
        todo_total: Option<u32>,
    }

    #[derive(Clone, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Usage {
        #[serde(default)]
        label: String,
        #[serde(default)]
        pct: f32,
        #[serde(default)]
        reset: String,
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
        #[serde(default)]
        mode: String,
        x: Option<i32>,
        y: Option<i32>,
        edge: Option<String>,
        along: Option<i32>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Snapshot {
        sessions: Option<Vec<Row>>,
        question: Option<Question>,
        usage: Option<Vec<Usage>>,
        sound: Option<bool>,
        sound_path: Option<String>,
        layout: Option<LayoutIn>,
        chime: Option<String>,
        auto_collapse: Option<bool>,
    }

    struct State {
        rows: Vec<Row>,
        question: Option<Question>,
        usage: Vec<Usage>,
        sound_enabled: bool,
        auto_collapse: bool,
        sound_path: Option<String>,
    }

    impl Default for State {
        fn default() -> Self {
            Self {
                rows: Vec::new(),
                question: None,
                usage: Vec::new(),
                sound_enabled: true,
                auto_collapse: true,
                sound_path: None,
            }
        }
    }

    // ── ui state ─────────────────────────────────────────────────────────────

    #[derive(Clone, Copy, PartialEq)]
    enum Mode {
        Island,
        DockedTab,
        Panel,
    }

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

    struct Anim {
        from: RECT,
        to: RECT,
        start: u64,
        dur: u32,
        /// Presentation to adopt once the slide lands (None = keep current).
        finish_mode: Option<Mode>,
    }

    struct Hit {
        rect: RECT,
        action: Action,
    }

    #[derive(Clone, PartialEq)]
    enum Action {
        Toggle,
        Focus,
        Interrupt(String),
        Sound,
        Hide,
        Answer(String, String), // requestID, option label
    }

    struct Ui {
        mode: Mode,
        /// Island anchor (top-left, screen coords) — where the pill lives and
        /// what the panel expands from.
        island: (i32, i32),
        /// When docked to a monitor edge, the pill renders as a thin tab and
        /// the panel flies out on hover, PC-Manager style.
        dock: Option<Edge>,
        /// Coordinate along the docked edge (x for top, y for sides).
        along: i32,
        hovering: bool,
        /// Manual drag state (own drag loop so click vs drag stays clean).
        drag_capture: bool,
        drag_moved: bool,
        drag_origin: (i32, i32),
        win_origin: (i32, i32),
        pulse: bool,
        frame: u8,
        /// Remaining pulse ticks of the "done" border flash.
        flash: u8,
        /// Ticks since the mouse left an expanded panel (auto-collapse).
        leave_ticks: u8,
        /// Clickable regions (client coords), rebuilt at paint.
        hits: Vec<Hit>,
        anim: Option<Anim>,
    }

    static STATE: Mutex<Option<State>> = Mutex::new(None);
    static UI: Mutex<Ui> = Mutex::new(Ui {
        mode: Mode::Island,
        island: (0, 0),
        dock: None,
        along: 0,
        hovering: false,
        drag_capture: false,
        drag_moved: false,
        drag_origin: (0, 0),
        win_origin: (0, 0),
        pulse: false,
        frame: 0,
        flash: 0,
        leave_ticks: 0,
        hits: Vec::new(),
        anim: None,
    });
    static CTX: Mutex<Option<(isize, f32)>> = Mutex::new(None);

    const WM_APP_UPDATE: u32 = WM_APP + 1;
    const WM_APP_DONE: u32 = WM_APP + 2;
    const TIMER_TICK: usize = 1;
    const TIMER_ANIM: usize = 2;
    const ANIM_MS: u32 = 160;
    const DRAG_THRESHOLD: i32 = 4;

    // 96-dpi layout constants (multiplied by the dpi scale at runtime).
    const ISLAND_W: i32 = 210;
    const ISLAND_H: i32 = 36;
    const PANEL_W: i32 = 420;
    const HEADER_H: i32 = 30;
    const ROW_H: i32 = 56;
    const FOOTER_H: i32 = 30;
    const QUESTION_TEXT_H: i32 = 34;
    const QUESTION_BTN_H: i32 = 24;
    const PAD: i32 = 10;
    const GUTTER: i32 = 46;
    const TAB_LEN: i32 = 56;
    const TAB_THICK: i32 = 12;
    const SNAP: i32 = 16;
    const TAB_BG: COLORREF = rgb(0x3a, 0x3d, 0x44);

    const BG: COLORREF = rgb(0x16, 0x18, 0x1c);
    const BG_RAISED: COLORREF = rgb(0x1c, 0x1f, 0x24);
    const EDGE_C: COLORREF = rgb(0x2a, 0x2d, 0x33);
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
    // StretchDIBits, so edges antialias against the background.

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

    // ── geometry ─────────────────────────────────────────────────────────────

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

    fn desired_panel_h(c: &Ctx) -> i32 {
        let guard = STATE.lock().unwrap();
        let (rows, question, question_btns) = match guard.as_ref() {
            Some(s) => (
                s.rows.len().clamp(1, 4) as i32,
                s.question.is_some(),
                s.question.as_ref().map(|q| !q.options.is_empty()).unwrap_or(false),
            ),
            None => (1, false, false),
        };
        let mut h = HEADER_H + rows * ROW_H;
        if question {
            h += QUESTION_TEXT_H;
            if question_btns {
                h += QUESTION_BTN_H + 6;
            }
        }
        h += FOOTER_H;
        px(c, h)
    }

    fn island_rect(c: &Ctx, island: (i32, i32)) -> (i32, i32, i32, i32) {
        (island.0, island.1, px(c, ISLAND_W), px(c, ISLAND_H))
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

    fn docked_panel_rect(c: &Ctx, mon: &RECT, edge: Edge, along: i32, h: i32) -> (i32, i32, i32, i32) {
        let w = px(c, PANEL_W);
        match edge {
            Edge::Top => ((along - w / 2 + px(c, TAB_LEN) / 2).clamp(mon.left + 8, (mon.right - w - 8).max(mon.left + 8)), mon.top, w, h),
            Edge::Left => (mon.left, along.clamp(mon.top + 8, (mon.bottom - h - 8).max(mon.top + 8)), w, h),
            Edge::Right => (mon.right - w, along.clamp(mon.top + 8, (mon.bottom - h - 8).max(mon.top + 8)), w, h),
        }
    }

    fn panel_rect(c: &Ctx, hwnd: HWND, island: (i32, i32)) -> (i32, i32, i32, i32) {
        let mon = monitor_rect(hwnd);
        let h = desired_panel_h(c);
        {
            let ui = UI.lock().unwrap();
            if let Some(edge) = ui.dock {
                let along = ui.along;
                drop(ui);
                return docked_panel_rect(c, &mon, edge, along, h);
            }
        }
        let w = px(c, PANEL_W);
        let island_w = px(c, ISLAND_W);
        let island_h = px(c, ISLAND_H);
        let cx = island.0 + island_w / 2;
        let x = (cx - w / 2).clamp(mon.left + 8, (mon.right - w - 8).max(mon.left + 8));
        let mid = (mon.top + mon.bottom) / 2;
        let y = if island.1 < mid { island.1 } else { island.1 + island_h - h };
        let y = y.clamp(mon.top + 8, (mon.bottom - h - 8).max(mon.top + 8));
        (x, y, w, h)
    }

    // ── animation ────────────────────────────────────────────────────────────

    fn start_anim(hwnd: HWND, to: (i32, i32, i32, i32), finish_mode: Option<Mode>) {
        let from = window_rect(hwnd);
        {
            let mut ui = UI.lock().unwrap();
            ui.anim = Some(Anim {
                from,
                to: RECT { left: to.0, top: to.1, right: to.0 + to.2, bottom: to.1 + to.3 },
                start: now_ms(),
                dur: ANIM_MS,
                finish_mode,
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
                let finish_mode = anim.finish_mode;
                ui.anim = None;
                if let Some(mode) = finish_mode {
                    ui.mode = mode;
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

    // ── expand / collapse / drag ─────────────────────────────────────────────

    fn expand(hwnd: HWND) {
        let c = ctx();
        let island = {
            let mut ui = UI.lock().unwrap();
            if ui.mode == Mode::Panel && ui.anim.is_none() {
                return;
            }
            ui.mode = Mode::Panel;
            ui.anim = None;
            ui.leave_ticks = 0;
            ui.island
        };
        let target = panel_rect(&c, hwnd, island);
        start_anim(hwnd, target, None);
    }

    fn collapse(hwnd: HWND) {
        let c = ctx();
        let (target, finish) = {
            let ui = UI.lock().unwrap();
            if ui.mode != Mode::Panel || ui.drag_capture {
                return;
            }
            if ui.anim.as_ref().and_then(|a| a.finish_mode).is_some() {
                return; // already collapsing
            }
            match ui.dock {
                Some(edge) => {
                    let mon = monitor_rect(hwnd);
                    (tab_rect(&c, &mon, edge, ui.along), Mode::DockedTab)
                }
                None => (island_rect(&c, ui.island), Mode::Island),
            }
        };
        start_anim(hwnd, target, Some(finish));
    }

    fn toggle(hwnd: HWND) {
        let mode = UI.lock().unwrap().mode;
        match mode {
            Mode::Island | Mode::DockedTab => expand(hwnd),
            Mode::Panel => collapse(hwnd),
        }
    }

    /// Re-apply the panel size after a snapshot changed the row/question count.
    fn apply_panel_size(hwnd: HWND) {
        let c = ctx();
        let target = {
            let ui = UI.lock().unwrap();
            if ui.mode != Mode::Panel || ui.anim.is_some() {
                return;
            }
            panel_rect(&c, hwnd, ui.island)
        };
        set_rect(hwnd, target.0, target.1, target.2, target.3);
    }

    fn emit_layout() {
        let ui = UI.lock().unwrap();
        match ui.dock {
            Some(edge) => emit_stdout(&format!(
                "{{\"event\":\"layout\",\"mode\":\"docked\",\"edge\":\"{}\",\"along\":{}}}",
                edge.name(),
                ui.along
            )),
            None => emit_stdout(&format!(
                "{{\"event\":\"layout\",\"mode\":\"floating\",\"x\":{},\"y\":{}}}",
                ui.island.0, ui.island.1
            )),
        }
    }

    /// After a manual drag ends: dock when dropped near a monitor edge
    /// (PC-Manager tab), otherwise derive the island anchor from wherever the
    /// window landed. Clamp on-screen, persist either way.
    fn settle_after_drag(hwnd: HWND) {
        let c = ctx();
        let mon = monitor_rect(hwnd);
        let rc = window_rect(hwnd);
        let island_w = px(&c, ISLAND_W);
        let island_h = px(&c, ISLAND_H);
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

        if let Some(edge) = edge {
            let target = {
                let mut ui = UI.lock().unwrap();
                ui.dock = Some(edge);
                ui.along = match edge {
                    Edge::Top => rc.left,
                    Edge::Left | Edge::Right => rc.top,
                };
                tab_rect(&c, &mon, edge, ui.along)
            };
            start_anim(hwnd, target, Some(Mode::DockedTab));
            emit_layout();
            return;
        }

        {
            let mut ui = UI.lock().unwrap();
            ui.dock = None;
            let (x, y) = match ui.mode {
                Mode::Island | Mode::DockedTab => (rc.left, rc.top),
                Mode::Panel => {
                    let cx = (rc.left + rc.right) / 2;
                    let mid = (mon.top + mon.bottom) / 2;
                    let y = if rc.top < mid { rc.top } else { rc.bottom - island_h };
                    (cx - island_w / 2, y)
                }
            };
            ui.island = (
                x.clamp(mon.left, (mon.right - island_w).max(mon.left)),
                y.clamp(mon.top, (mon.bottom - island_h).max(mon.top)),
            );
            // Dragging a tab away from the edge turns it back into an island.
            if ui.mode == Mode::DockedTab {
                ui.mode = Mode::Island;
                drop(ui);
                set_rect(hwnd, rc.left, rc.top, island_w, island_h);
            }
        }
        emit_layout();
    }

    fn track_leave(hwnd: HWND) {
        let mut tme = TRACKMOUSEEVENT {
            cbSize: std::mem::size_of::<TRACKMOUSEEVENT>() as u32,
            dwFlags: TME_LEAVE,
            hwndTrack: hwnd,
            dwHoverTime: 0,
        };
        unsafe { TrackMouseEvent(&mut tme) };
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
            let mon = monitor_rect(hwnd);
            {
                let mut ui = UI.lock().unwrap();
                ui.dock = Some(edge);
                ui.along = along;
                ui.mode = Mode::DockedTab;
            }
            let (x, y, w, h) = tab_rect(&c, &mon, edge, along);
            set_rect(hwnd, x, y, w, h);
            unsafe { InvalidateRect(hwnd, std::ptr::null(), 0) };
            return;
        }
        let (Some(x), Some(y)) = (layout.x, layout.y) else { return };
        let mon = monitor_rect(hwnd);
        let w = px(&c, ISLAND_W);
        let h = px(&c, ISLAND_H);
        let x = x.clamp(mon.left, (mon.right - w).max(mon.left));
        let y = y.clamp(mon.top, (mon.bottom - h).max(mon.top));
        let apply = {
            let mut ui = UI.lock().unwrap();
            ui.island = (x, y);
            ui.mode == Mode::Island
        };
        if apply {
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
                        state.usage = snapshot.usage.unwrap_or_default();
                    } else {
                        if snapshot.question.is_some() {
                            state.question = snapshot.question;
                        }
                        if let Some(usage) = snapshot.usage {
                            state.usage = usage;
                        }
                    }
                    if let Some(v) = snapshot.sound {
                        state.sound_enabled = v;
                    }
                    if snapshot.sound_path.is_some() {
                        state.sound_path = snapshot.sound_path;
                    }
                    if let Some(v) = snapshot.auto_collapse {
                        state.auto_collapse = v;
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
                apply_panel_size(hwnd);
                InvalidateRect(hwnd, std::ptr::null(), 0);
                0
            }
            WM_APP_DONE => {
                {
                    let mut ui = UI.lock().unwrap();
                    ui.flash = 6;
                }
                apply_panel_size(hwnd);
                InvalidateRect(hwnd, std::ptr::null(), 0);
                0
            }
            WM_TIMER if wparam == TIMER_ANIM => {
                step_anim(hwnd);
                0
            }
            WM_TIMER => {
                let mut repaint = false;
                let mut auto_collapse = false;
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
                    // Auto-collapse the panel a beat after the mouse wanders off
                    // (docked panels always retract; floating ones only when the
                    // auto-collapse preference is on).
                    let auto_ok = ui.dock.is_some()
                        || STATE.lock().unwrap().as_ref().map(|s| s.auto_collapse).unwrap_or(true);
                    if auto_ok && ui.mode == Mode::Panel && !ui.hovering && !ui.drag_capture && ui.anim.is_none() {
                        ui.leave_ticks = ui.leave_ticks.saturating_add(1);
                        if ui.leave_ticks >= 3 {
                            ui.leave_ticks = 0;
                            auto_collapse = true;
                        }
                    } else {
                        ui.leave_ticks = 0;
                    }
                }
                if auto_collapse {
                    collapse(hwnd);
                }
                if repaint {
                    InvalidateRect(hwnd, std::ptr::null(), 0);
                }
                0
            }
            WM_DPICHANGED => {
                let dpi = (wparam & 0xffff) as u32;
                {
                    let mut guard = CTX.lock().unwrap();
                    if let Some((terminal, _)) = *guard {
                        *guard = Some((terminal, (dpi as f32) / 96.0));
                    }
                }
                let suggested = lparam as *const RECT;
                if !suggested.is_null() {
                    let rc = *suggested;
                    set_rect(hwnd, rc.left, rc.top, rc.right - rc.left, rc.bottom - rc.top);
                    let mut ui = UI.lock().unwrap();
                    if ui.mode == Mode::Island {
                        ui.island = (rc.left, rc.top);
                    }
                }
                apply_panel_size(hwnd);
                InvalidateRect(hwnd, std::ptr::null(), 0);
                0
            }
            WM_LBUTTONDOWN => {
                let mut pt = POINT { x: 0, y: 0 };
                GetCursorPos(&mut pt);
                let rc = window_rect(hwnd);
                {
                    let mut ui = UI.lock().unwrap();
                    ui.drag_capture = true;
                    ui.drag_moved = false;
                    ui.drag_origin = (pt.x, pt.y);
                    ui.win_origin = (rc.left, rc.top);
                }
                SetCapture(hwnd);
                0
            }
            WM_MOUSEMOVE => {
                let dragging = {
                    let mut ui = UI.lock().unwrap();
                    ui.hovering = true;
                    ui.leave_ticks = 0;
                    if ui.drag_capture {
                        let mut pt = POINT { x: 0, y: 0 };
                        GetCursorPos(&mut pt);
                        let dx = pt.x - ui.drag_origin.0;
                        let dy = pt.y - ui.drag_origin.1;
                        let c = ctx();
                        if !ui.drag_moved
                            && (dx.abs() > px(&c, DRAG_THRESHOLD) || dy.abs() > px(&c, DRAG_THRESHOLD))
                        {
                            ui.drag_moved = true;
                        }
                        if ui.drag_moved {
                            Some((ui.win_origin.0 + dx, ui.win_origin.1 + dy))
                        } else {
                            None
                        }
                    } else {
                        None
                    }
                };
                if let Some((wx, wy)) = dragging {
                    let rc = window_rect(hwnd);
                    set_rect(hwnd, wx, wy, rc.right - rc.left, rc.bottom - rc.top);
                } else {
                    // Hovering a docked tab flies the panel out, PC-Manager style.
                    let is_tab = { UI.lock().unwrap().mode == Mode::DockedTab };
                    if is_tab {
                        expand(hwnd);
                    }
                    track_leave(hwnd);
                }
                0
            }
            WM_MOUSELEAVE => {
                UI.lock().unwrap().hovering = false;
                0
            }
            WM_LBUTTONUP => {
                ReleaseCapture();
                let was_drag = {
                    let mut ui = UI.lock().unwrap();
                    let was = ui.drag_capture && ui.drag_moved;
                    ui.drag_capture = false;
                    ui.drag_moved = false;
                    was
                };
                if was_drag {
                    settle_after_drag(hwnd);
                    return 0;
                }
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
                    Some(Action::Toggle) => toggle(hwnd),
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
            WM_RBUTTONUP => {
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

    unsafe fn draw_goblin(
        dc: HDC,
        c: &Ctx,
        x: i32,
        y: i32,
        w: i32,
        h: i32,
        working: bool,
        done: bool,
        frame: u8,
    ) {
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
            px(c, w),
            px(c, h),
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

    fn usage_color(pct: f32) -> COLORREF {
        if pct < 50.0 {
            GREEN
        } else if pct < 80.0 {
            GOLD
        } else {
            RED
        }
    }

    fn row_elapsed(row: &Row) -> String {
        if row.working {
            row.started_at_ms
                .map(|s| fmt_dur(now_ms().saturating_sub(s) / 1000))
                .unwrap_or_default()
        } else if let Some(done_at) = row.done_at_ms {
            fmt_ago(done_at)
        } else {
            String::new()
        }
    }

    fn row_state_color(row: &Row, pulse: bool) -> COLORREF {
        if row.error {
            RED
        } else if row.working {
            if pulse {
                GREEN
            } else {
                GREEN_DIM
            }
        } else if row.done {
            GOLD
        } else {
            EDGE_C
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

        let mem = CreateCompatibleDC(hdc);
        let bmp = CreateCompatibleBitmap(hdc, w, h);
        let old_bmp = SelectObject(mem, bmp as HGDIOBJ);
        SetBkMode(mem, TRANSPARENT as i32);

        let (mode, pulse, frame, flash) = {
            let ui = UI.lock().unwrap();
            (ui.mode, ui.pulse, ui.frame, ui.flash)
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
        let working_count = state.rows.iter().filter(|r| r.working).count();
        let mut hits: Vec<Hit> = Vec::new();

        fill(mem, &rc, BG);
        let border = if flash > 0 && flash % 2 == 0 { GREEN } else { EDGE_C };
        let edge_brush = CreateSolidBrush(border);
        FrameRect(mem, &rc, edge_brush);
        DeleteObject(edge_brush as HGDIOBJ);

        let pad = px(&c, PAD);
        let title_font = make_font(&c, 12, 600);
        let body_font = make_font(&c, 11, 400);
        let small_font = make_font(&c, 10, 400);

        if mode == Mode::DockedTab {
            // ── docked tab (PC-Manager) ──
            fill(mem, &rc, TAB_BG);
            let strip_color = if primary.error {
                RED
            } else if primary.working {
                if pulse { GREEN } else { GREEN_DIM }
            } else if primary.done {
                GOLD
            } else {
                EDGE_C
            };
            let dock_edge = { UI.lock().unwrap().dock.unwrap_or(Edge::Top) };
            let t = px(&c, 3);
            let strip = match dock_edge {
                Edge::Top => RECT { left: rc.left, top: rc.bottom - t, right: rc.right, bottom: rc.bottom },
                Edge::Left => RECT { left: rc.right - t, top: rc.top, right: rc.right, bottom: rc.bottom },
                Edge::Right => RECT { left: rc.left, top: rc.top, right: rc.left + t, bottom: rc.bottom },
            };
            fill(mem, &strip, strip_color);
            hits.push(Hit { rect: rc, action: Action::Toggle });
        } else if mode == Mode::Island {
            // ── compact island ──
            draw_goblin(mem, &c, pad, (h - px(&c, 19)) / 2, 26, 19, primary.working, primary.done, frame);

            // Badge: count of working sessions, or a gold check when done.
            let badge_w = px(&c, 22);
            let badge_h = px(&c, 18);
            let badge = RECT {
                left: w - pad - badge_w,
                top: (h - badge_h) / 2,
                right: w - pad,
                bottom: (h - badge_h) / 2 + badge_h,
            };
            fill(mem, &badge, BG_RAISED);
            let badge_frame = CreateSolidBrush(if working_count > 0 && pulse { GREEN_DIM } else { EDGE_C });
            FrameRect(mem, &badge, badge_frame);
            DeleteObject(badge_frame as HGDIOBJ);
            let (badge_text, badge_color) = if working_count > 0 {
                (working_count.to_string(), GREEN)
            } else if state.rows.iter().any(|r| r.done) {
                ("✓".to_string(), GOLD)
            } else {
                ("·".to_string(), FAINT_FG)
            };
            let mut badge_rc = badge;
            draw_text(
                mem,
                small_font,
                badge_color,
                &mut badge_rc,
                &badge_text,
                DT_CENTER | DT_VCENTER | DT_SINGLELINE,
            );

            let mut title_rc = RECT {
                left: pad + px(&c, 32),
                top: 0,
                right: w - pad - badge_w - px(&c, 6),
                bottom: h,
            };
            let title = if primary.title.is_empty() { "CodeGoblin" } else { &primary.title };
            draw_text(
                mem,
                title_font,
                TITLE_FG,
                &mut title_rc,
                title,
                DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_END_ELLIPSIS,
            );

            // The whole island toggles open.
            hits.push(Hit { rect: rc, action: Action::Toggle });
        } else {
            // ── expanded panel ──
            let header_h = px(&c, HEADER_H);

            // Header: usage strip (subscription accounts) or spend/ctx fallback.
            let header_rc = RECT { left: 1, top: 1, right: w - 1, bottom: header_h };
            fill(mem, &header_rc, BG_RAISED);
            let sep = RECT { left: 1, top: header_h, right: w - 1, bottom: header_h + 1 };
            fill(mem, &sep, EDGE_C);

            let mut mark_rc = RECT { left: pad, top: 1, right: pad + px(&c, 14), bottom: header_h };
            draw_text(mem, body_font, GOLD, &mut mark_rc, "✦", DT_LEFT | DT_VCENTER | DT_SINGLELINE);

            let mut x_cursor = pad + px(&c, 18);
            if !state.usage.is_empty() {
                for (i, usage) in state.usage.iter().take(3).enumerate() {
                    if i > 0 {
                        let mut dot_rc =
                            RECT { left: x_cursor, top: 1, right: x_cursor + px(&c, 12), bottom: header_h };
                        draw_text(mem, small_font, FAINT_FG, &mut dot_rc, "·", DT_CENTER | DT_VCENTER | DT_SINGLELINE);
                        x_cursor += px(&c, 12);
                    }
                    let segment = format!("{} ", usage.label);
                    let mut seg_rc = RECT { left: x_cursor, top: 1, right: w - pad, bottom: header_h };
                    draw_text(mem, small_font, STATUS_FG, &mut seg_rc, &segment, DT_LEFT | DT_VCENTER | DT_SINGLELINE);
                    x_cursor += (segment.chars().count() as i32) * px(&c, 6);
                    let pct = format!("{}%", usage.pct.round() as i32);
                    let mut pct_rc = RECT { left: x_cursor, top: 1, right: w - pad, bottom: header_h };
                    draw_text(mem, small_font, usage_color(usage.pct), &mut pct_rc, &pct, DT_LEFT | DT_VCENTER | DT_SINGLELINE);
                    x_cursor += (pct.chars().count() as i32) * px(&c, 7);
                    if !usage.reset.is_empty() {
                        let reset = format!(" {}", usage.reset);
                        let mut reset_rc = RECT { left: x_cursor, top: 1, right: w - pad, bottom: header_h };
                        draw_text(mem, small_font, FAINT_FG, &mut reset_rc, &reset, DT_LEFT | DT_VCENTER | DT_SINGLELINE);
                        x_cursor += (reset.chars().count() as i32) * px(&c, 6);
                    }
                }
            } else {
                let mut fallback = String::new();
                if let Some(spend) = primary.spend.as_ref().filter(|s| !s.is_empty()) {
                    fallback.push_str(spend);
                }
                if let Some(ctx_text) = primary.ctx.as_ref().filter(|s| !s.is_empty()) {
                    if !fallback.is_empty() {
                        fallback.push_str("  ·  ");
                    }
                    fallback.push_str(ctx_text);
                }
                if fallback.is_empty() {
                    fallback.push_str("CodeGoblin");
                }
                let mut fb_rc = RECT { left: x_cursor, top: 1, right: w - pad - px(&c, 20), bottom: header_h };
                draw_text(
                    mem,
                    small_font,
                    STATUS_FG,
                    &mut fb_rc,
                    &fallback,
                    DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_END_ELLIPSIS,
                );
            }

            let mut chevron_rc = RECT { left: w - pad - px(&c, 14), top: 1, right: w - pad, bottom: header_h };
            draw_text(mem, body_font, FAINT_FG, &mut chevron_rc, "▴", DT_RIGHT | DT_VCENTER | DT_SINGLELINE);
            hits.push(Hit {
                rect: RECT { left: 1, top: 1, right: w - 1, bottom: header_h },
                action: Action::Toggle,
            });

            // ── session rows ──
            let gutter = px(&c, GUTTER);
            let row_h = px(&c, ROW_H);
            let mut y = header_h + 1;
            for (i, row) in state.rows.iter().take(4).enumerate() {
                let row_rc = RECT { left: 1, top: y, right: w - 1, bottom: y + row_h };
                if i == 0 {
                    draw_goblin(mem, &c, pad, y + (row_h - px(&c, 22)) / 2, 30, 22, row.working, row.done, frame);
                } else {
                    let dot = px(&c, 8);
                    let dot_x = pad + (gutter - pad - dot) / 2;
                    let dot_rc = RECT {
                        left: dot_x,
                        top: y + (row_h - dot) / 2,
                        right: dot_x + dot,
                        bottom: y + (row_h - dot) / 2 + dot,
                    };
                    fill(mem, &dot_rc, row_state_color(row, pulse));
                }

                let elapsed = row_elapsed(row);
                let mut right_w = 0;
                if !elapsed.is_empty() {
                    right_w = px(&c, 58);
                    let mut el_rc = RECT {
                        left: w - pad - right_w,
                        top: y + px(&c, 4),
                        right: w - pad,
                        bottom: y + px(&c, 20),
                    };
                    draw_text(mem, small_font, FAINT_FG, &mut el_rc, &elapsed, DT_RIGHT | DT_SINGLELINE);
                }
                let mut title_rc = RECT {
                    left: gutter,
                    top: y + px(&c, 4),
                    right: w - pad - right_w - px(&c, 4),
                    bottom: y + px(&c, 22),
                };
                let title = if row.title.is_empty() { "CodeGoblin" } else { &row.title };
                draw_text(mem, title_font, TITLE_FG, &mut title_rc, title, DT_LEFT | DT_SINGLELINE | DT_END_ELLIPSIS);

                // Line 2: the prompt that started this run (vibeisland's "You: …").
                if let Some(prompt) = row.prompt.as_ref().filter(|s| !s.is_empty()) {
                    let mut prompt_rc = RECT {
                        left: gutter,
                        top: y + px(&c, 22),
                        right: w - pad,
                        bottom: y + px(&c, 36),
                    };
                    let line = format!("You: {}", prompt);
                    draw_text(mem, small_font, FAINT_FG, &mut prompt_rc, &line, DT_LEFT | DT_SINGLELINE | DT_END_ELLIPSIS);
                }

                // Line 3: status left; todo count and model right.
                let mut meta = String::new();
                if let (Some(done), Some(total)) = (row.todo_done, row.todo_total) {
                    if total > 0 {
                        meta = format!("{}/{}", done.min(total), total);
                    }
                }
                if let Some(model) = row.model.as_ref().filter(|s| !s.is_empty()) {
                    if !meta.is_empty() {
                        meta.push_str(" · ");
                    }
                    meta.push_str(model);
                }
                let mut meta_w = 0;
                if !meta.is_empty() {
                    meta_w = px(&c, 130);
                    let mut meta_rc = RECT {
                        left: w - pad - meta_w,
                        top: y + px(&c, 37),
                        right: w - pad,
                        bottom: y + row_h - px(&c, 3),
                    };
                    draw_text(mem, small_font, FAINT_FG, &mut meta_rc, &meta, DT_RIGHT | DT_SINGLELINE | DT_END_ELLIPSIS);
                }
                let status = if !row.status.is_empty() {
                    row.status.as_str()
                } else if row.working {
                    "goblin working…"
                } else {
                    "idle"
                };
                let status_color = if row.error {
                    RED
                } else if row.done {
                    GOLD
                } else if row.working {
                    GREEN
                } else {
                    STATUS_FG
                };
                let mut status_rc = RECT {
                    left: gutter,
                    top: y + px(&c, 37),
                    right: w - pad - meta_w - px(&c, 4),
                    bottom: y + row_h - px(&c, 3),
                };
                draw_text(mem, small_font, status_color, &mut status_rc, status, DT_LEFT | DT_SINGLELINE | DT_END_ELLIPSIS);

                hits.push(Hit { rect: row_rc, action: Action::Focus });
                y += row_h;
            }

            // ── question preview ──
            if let Some(question) = state.question.as_ref() {
                let mut marker_rc = RECT { left: pad, top: y + px(&c, 4), right: gutter, bottom: y + px(&c, 22) };
                draw_text(mem, title_font, GOLD, &mut marker_rc, "?", DT_CENTER | DT_SINGLELINE);
                let mut q_rc = RECT {
                    left: gutter,
                    top: y + px(&c, 3),
                    right: w - pad,
                    bottom: y + px(&c, QUESTION_TEXT_H),
                };
                draw_text(mem, body_font, TITLE_FG, &mut q_rc, &question.text, DT_LEFT | DT_WORDBREAK | DT_END_ELLIPSIS);
                y += px(&c, QUESTION_TEXT_H);

                if !question.options.is_empty() {
                    let count = question.options.len().min(3) as i32;
                    let gap = px(&c, 6);
                    let btn_w = (w - pad - gutter - gap * (count - 1)) / count;
                    let btn_h = px(&c, QUESTION_BTN_H);
                    for (i, option) in question.options.iter().take(3).enumerate() {
                        let left = gutter + (btn_w + gap) * (i as i32);
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
                    y += btn_h + px(&c, 6);
                }
            }
            let _ = y;

            // ── footer buttons ──
            let footer_top = h - px(&c, FOOTER_H);
            let sep = RECT { left: 1, top: footer_top, right: w - 1, bottom: footer_top + 1 };
            fill(mem, &sep, EDGE_C);

            let mut entries: Vec<(String, Action, COLORREF)> =
                vec![("focus".into(), Action::Focus, STATUS_FG)];
            // Only offer esc when exactly one session is working — with several
            // running, a panel-level button can't say which one it would kill.
            if primary.working && working_count == 1 && !primary.id.is_empty() {
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
                let cell_rc = RECT { left, top: footer_top + 1, right: left + cell_w, bottom: h - 1 };
                if i > 0 {
                    let div = RECT { left, top: footer_top + px(&c, 7), right: left + 1, bottom: h - px(&c, 7) };
                    fill(mem, &div, EDGE_C);
                }
                let mut label_rc = cell_rc;
                draw_text(mem, small_font, color, &mut label_rc, &label, DT_CENTER | DT_VCENTER | DT_SINGLELINE);
                hits.push(Hit { rect: cell_rc, action });
            }
        }

        drop(guard);
        UI.lock().unwrap().hits = hits;

        DeleteObject(title_font);
        DeleteObject(body_font);
        DeleteObject(small_font);

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
                style: CS_HREDRAW | CS_VREDRAW | CS_DROPSHADOW,
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

            // Scale from the terminal's monitor (updated later by WM_DPICHANGED
            // when the widget is dragged across monitors).
            let dpi = if !terminal.is_null() {
                let mon = MonitorFromWindow(terminal, MONITOR_DEFAULTTONEAREST);
                let mut dx: u32 = 96;
                let mut dy: u32 = 96;
                if windows_sys::Win32::UI::HiDpi::GetDpiForMonitor(mon, 0, &mut dx, &mut dy) == 0 {
                    dx
                } else {
                    windows_sys::Win32::UI::HiDpi::GetDpiForSystem()
                }
            } else {
                windows_sys::Win32::UI::HiDpi::GetDpiForSystem()
            };
            let scale = (dpi as f32) / 96.0;
            *CTX.lock().unwrap() = Some((terminal as isize, scale));
            let c = ctx();

            let width = px(&c, ISLAND_W);
            let height = px(&c, ISLAND_H);

            // Land on the monitor the terminal lives on: top-center, like a
            // proper island; falls back to the primary work area.
            let mut work = RECT { left: 0, top: 0, right: 1280, bottom: 720 };
            let mut placed = false;
            if !terminal.is_null() {
                let mon = MonitorFromWindow(terminal, MONITOR_DEFAULTTONEAREST);
                let mut info: MONITORINFO = std::mem::zeroed();
                info.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
                if GetMonitorInfoW(mon, &mut info) != 0 {
                    work = info.rcWork;
                    placed = true;
                }
            }
            if !placed {
                SystemParametersInfoW(SPI_GETWORKAREA, 0, &mut work as *mut _ as *mut _, 0);
            }
            let x = work.left + (work.right - work.left - width) / 2;
            let y = work.top + px(&c, 8);
            UI.lock().unwrap().island = (x, y);

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
