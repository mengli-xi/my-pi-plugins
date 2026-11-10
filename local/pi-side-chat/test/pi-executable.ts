/** Real-host regressions must name an explicit binary and always use a private profile. */
export function testPiExecutable(): string {
  const executable = process.env.PI_TEST_EXECUTABLE ?? process.env.PI_EXECUTABLE;
  if (!executable) throw new Error("Set PI_TEST_EXECUTABLE to the stock Pi 1.5.0 binary");
  return executable;
}
