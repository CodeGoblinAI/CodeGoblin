import { fetchBalance, balanceRows } from "../src/core/balance"
import { apiKey } from "../src/core/auth"

const provider = process.argv[2] || "deepseek"
const snapshot = await fetchBalance(provider, apiKey(provider))
for (const [label, value] of balanceRows(snapshot)) console.log(label + ": " + value)
if (snapshot.state !== "ready") process.exitCode = 1
