import type { SlashCommand } from "./slash-popover"

export const slashListOptions = {
  key: (command: SlashCommand) => command.id,
  filterKeys: ["trigger", "aliasSearch", "title"],
  // useFilteredList applies this after fuzzy matching. A stable sort preserves
  // relevance within each kind while settings stay ahead of matching skills.
  sortBy: (a: SlashCommand, b: SlashCommand) => Number(b.type === "builtin") - Number(a.type === "builtin"),
}
