export function assertParityCoverage(results) {
  const cells = results.filter((result) => result.invariant === "client_parity");
  if (cells.length === 0 || cells.some((cell) => cell.skipped)) {
    throw new Error("Required client parity was not exercised for every workspace.");
  }
  if (cells.some((cell) => !Array.isArray(cell.detail?.periods) || cell.detail.periods.length === 0)) {
    throw new Error("Required client parity compared zero periods for a workspace.");
  }
  const compared = cells.reduce((count, cell) => count + cell.detail.periods.length, 0);
  return compared;
}
