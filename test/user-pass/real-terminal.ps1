# Look at the terminal app in a real Windows Terminal window, without desktop control:
#   real-terminal.ps1 shot <title> <out.png>     picture of the window whose title contains <title>, even if covered
#   real-terminal.ps1 keys <pid> <text>          type into the console of process <pid>, without touching focus
# In <text>: {ENTER} {ESC} {TAB} {UP} {DOWN} {LEFT} {RIGHT} {BACKSPACE} {STAB} (shift+tab) {CTRL+x}; anything else is typed.
# Used by tui-window.mjs. Only ever pointed at the window and process that script started.
param([string]$Action, [string]$Target, [string]$Value)

# Run with Windows PowerShell (powershell.exe), where System.Drawing is the full framework's.
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @"
using System;
using System.Text;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
public static class RealTerminal {
  delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc proc, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }

  public static IntPtr Find(string title) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((hwnd, l) => {
      if (!IsWindowVisible(hwnd)) return true;
      var text = new StringBuilder(512);
      GetWindowText(hwnd, text, 512);
      if (text.ToString().Contains(title)) { found = hwnd; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  public static string Shot(string title, string path) {
    SetProcessDPIAware();
    var hwnd = Find(title);
    if (hwnd == IntPtr.Zero) return "no window titled " + title;
    RECT r; GetWindowRect(hwnd, out r);
    int w = r.Right - r.Left, h = r.Bottom - r.Top;
    if (w <= 0 || h <= 0) return "window has no size";
    using (var bitmap = new Bitmap(w, h)) {
      using (var g = Graphics.FromImage(bitmap)) {
        IntPtr hdc = g.GetHdc();
        PrintWindow(hwnd, hdc, 2); // PW_RENDERFULLCONTENT: the window's own pixels, whatever is in front of it
        g.ReleaseHdc(hdc);
      }
      bitmap.Save(path, ImageFormat.Png);
    }
    return "saved " + w + "x" + h;
  }

  [DllImport("kernel32.dll")] static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr sec, uint disp, uint flags, IntPtr tmpl);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool WriteConsoleInput(IntPtr handle, INPUT_RECORD[] records, uint count, out uint written);
  [StructLayout(LayoutKind.Explicit, CharSet = CharSet.Unicode)] struct INPUT_RECORD {
    [FieldOffset(0)] public ushort EventType;
    [FieldOffset(4)] public int KeyDown;
    [FieldOffset(8)] public ushort Repeat;
    [FieldOffset(10)] public ushort VirtualKey;
    [FieldOffset(12)] public ushort ScanCode;
    [FieldOffset(14)] public char Char;
    [FieldOffset(16)] public uint Control;
  }
  static INPUT_RECORD Key(bool down, ushort vk, char ch, uint control) {
    return new INPUT_RECORD { EventType = 1, KeyDown = down ? 1 : 0, Repeat = 1, VirtualKey = vk, ScanCode = 0, Char = ch, Control = control };
  }

  public static string Keys(uint pid, string text) {
    FreeConsole();
    if (!AttachConsole(pid)) return "could not attach to console of " + pid + " (error " + Marshal.GetLastWin32Error() + ")";
    IntPtr input = CreateFile("CONIN$", 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
    if (input == new IntPtr(-1)) return "could not open the console input";
    int sent = 0;
    for (int i = 0; i < text.Length; i++) {
      ushort vk = 0; char ch = text[i]; uint control = 0;
      if (ch == '{') {
        int end = text.IndexOf('}', i);
        if (end > i) {
          string name = text.Substring(i + 1, end - i - 1).ToUpperInvariant();
          i = end;
          switch (name) {
            case "ENTER": vk = 0x0D; ch = '\r'; break;
            case "ESC": vk = 0x1B; ch = (char)27; break;
            case "TAB": vk = 0x09; ch = '\t'; break;
            case "STAB": vk = 0x09; ch = '\t'; control = 0x10; break;
            case "BACKSPACE": vk = 0x08; ch = (char)8; break;
            case "UP": vk = 0x26; ch = (char)0; control = 0x100; break;
            case "DOWN": vk = 0x28; ch = (char)0; control = 0x100; break;
            case "LEFT": vk = 0x25; ch = (char)0; control = 0x100; break;
            case "RIGHT": vk = 0x27; ch = (char)0; control = 0x100; break;
            default:
              if (name.StartsWith("CTRL+") && name.Length == 6) { char c = name[5]; vk = (ushort)c; ch = (char)(c - 64); control = 0x08; }
              else continue;
              break;
          }
        }
      }
      var records = new[] { Key(true, vk, ch, control), Key(false, vk, ch, control) };
      uint written;
      if (WriteConsoleInput(input, records, 2, out written)) sent++;
    }
    return "sent " + sent + " keys";
  }
}
"@

if ($Action -eq 'shot') { [RealTerminal]::Shot($Target, $Value) }
elseif ($Action -eq 'keys') { [RealTerminal]::Keys([uint32]$Target, $Value) }
else { "usage: real-terminal.ps1 shot <title> <out.png> | keys <pid> <text>" }
