/** A count and its word, as the panel and the agents' text say it: "1 file", "3 files", or with `many`, "2 replies". */
export const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
