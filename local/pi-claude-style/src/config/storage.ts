// A separate cold CJS bundle keeps the synchronous Conf API usable from stock
// Pi's compiled Bun host without importing its ESM graph during startup.
export { default } from "conf";
