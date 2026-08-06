// The indexer every v2 path imports (WP-13). v1 (@babel/parser, exact spans, honest
// error-recovery-means-opaque) is the default; v0 remains in the tree as the documented
// floor, the fixture parser, and the parity baseline — never delete it (correction C3).
export { indexFile, indexTree, tokensOf, treeHashOf, diffIndex } from "./indexerV1.mjs";
