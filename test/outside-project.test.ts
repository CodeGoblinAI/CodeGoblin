import { describe, expect, test } from "bun:test"
import { Permissions, coverOf, isReadOnlyCommand } from "../src/core/permission"

/**
 * Found by driving the real page with the real model.
 *
 * Approve for me ran read-only commands without asking, and read-only said
 * nothing about where: type or cat of a file anywhere on the disk - the key
 * store, ~/.ssh - would have run unasked. And an approval for one PowerShell
 * script covered every command that started "powershell -NoProfile".
 */
const shell = (command: string) => JSON.stringify({ command })

describe("a read-only command that reaches outside the project asks", () => {
  test("drives, shares, the home directory, environment variables and ways up", () => {
    const outside = [
      "type C:\\Windows\\win.ini",
      "cat ../secrets.txt",
      "type src\\..\\..\\other.txt",
      "cat ~/.ssh/id_rsa",
      "type %USERPROFILE%\\.local\\share\\codegoblin\\auth.json",
      "cat $HOME/.local/share/codegoblin/auth.json",
      "dir \\\\server\\share",
      "ls /etc",
      "rg --glob=C:/Users/*.json key",
      "git -C C:\\other\\repo log",
      "git --git-dir=../x/.git log",
      "cd .. && dir",
    ]
    for (const command of outside) {
      expect([command, isReadOnlyCommand(command)]).toEqual([command, false])
    }
  })

  test("the same commands inside the project still go through, Windows switches included", () => {
    const inside = ["type src\\math.js", "cat README.md", "dir /s /b", "dir /a:h", "cd src && dir", "git log -- src/math.js", "rg sum src"]
    for (const command of inside) {
      expect([command, isReadOnlyCommand(command)]).toEqual([command, true])
    }
  })

  test("so Approve for me asks before reading outside, and not before reading inside", async () => {
    const asked: string[] = []
    const permissions = new Permissions(async (_tool, detail) => {
      asked.push(detail)
      return "reject"
    })
    permissions.mode = "approve"
    expect(await permissions.check("shell", shell("type src\\math.js"))).toBe(true)
    expect(await permissions.check("shell", shell("type C:\\Windows\\win.ini"))).toBe(false)
    expect(asked.length).toBe(1)
  })

  test("approving a read for the session never covers a read outside the project", async () => {
    // Seen on the real page: the prompt for type C:\Windows\win.ini offered to
    // cover "type", which in Ask mode would then have let any type run unasked.
    let asked = 0
    const permissions = new Permissions(async () => {
      asked++
      return "always"
    })
    await permissions.check("shell", shell("type src\\math.js"))
    await permissions.check("shell", shell("type src\\other.js"))
    await permissions.check("shell", shell("type C:\\Windows\\win.ini"))
    expect(asked).toBe(2)
    expect(coverOf("shell", shell("type C:\\Windows\\win.ini"))).toBe('"type" in C:\\Windows')
  })
})

describe("Allow for this session, outside the project, holds for that folder", () => {
  // Seen on the real page: a write to Downloads was allowed for the session,
  // and the next command in Downloads asked again.
  test("the same program in the same folder, however the folder is spelled, does not ask again", async () => {
    let asked = 0
    const permissions = new Permissions(async () => {
      asked++
      return "always"
    })
    permissions.mode = "approve"
    const downloads = process.env.USERPROFILE ? process.env.USERPROFILE + "\\Downloads" : "C:\\Users\\me\\Downloads"
    await permissions.check("shell", shell('echo one > "%USERPROFILE%\\Downloads\\test.txt"'))
    await permissions.check("shell", shell("echo two > " + downloads + "\\test.txt"))
    await permissions.check("shell", shell("echo three > " + downloads + "\\other.txt"))
    expect(asked).toBe(process.env.USERPROFILE ? 1 : 2)
  })

  test("but not another folder, and not another program", async () => {
    let asked = 0
    const permissions = new Permissions(async () => {
      asked++
      return "always"
    })
    await permissions.check("shell", shell("type C:\\Windows\\win.ini"))
    await permissions.check("shell", shell("type C:\\Windows\\System32\\drivers\\etc\\hosts"))
    await permissions.check("shell", shell("more C:\\Windows\\win.ini"))
    expect(asked).toBe(3)
  })
})

describe("an interpreter given flags before its script is approved exactly", () => {
  test("powershell -NoProfile -File one.ps1 does not cover another script", async () => {
    let asked = 0
    const permissions = new Permissions(async () => {
      asked++
      return "always"
    })
    await permissions.check("shell", shell("powershell -NoProfile -ExecutionPolicy Bypass -File .\\cleanup-once.ps1"))
    await permissions.check("shell", shell("powershell -NoProfile -ExecutionPolicy Bypass -File .\\anything-else.ps1"))
    expect(asked).toBe(2)
  })

  test("and the prompt says so", () => {
    expect(coverOf("shell", shell("powershell -NoProfile -File a.ps1"))).toBe("this exact powershell command")
    expect(coverOf("shell", shell("node --test src/math.test.js"))).toBe("this exact node command")
  })

  test("a script named first is still approved by its name", () => {
    expect(coverOf("shell", shell("node build.js --watch"))).toBe('"node build.js"')
  })
})
