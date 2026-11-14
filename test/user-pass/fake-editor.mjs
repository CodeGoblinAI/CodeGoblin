// A stand-in editor for the /editor user pass: appends a line to the file it is given and exits.
import fs from "node:fs"
const file = process.argv[2]
fs.writeFileSync(file, fs.readFileSync(file, "utf8") + "\nwritten in the editor\n")
