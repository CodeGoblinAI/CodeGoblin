// Replaces @codegoblin/core/installation/version.
// The build stamps the released version in; from source it is the version in package.json, marked as such.
import pkg from "../../package.json"
export const InstallationVersion = process.env.CODEGOBLIN_VERSION ?? pkg.version + "-dev"
