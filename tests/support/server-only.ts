/**
 * A stand-in for the `server-only` package when a test imports a server module.
 *
 * `server-only` exists to make a BUILD fail if server code is pulled into a
 * client bundle. There is no bundle here, and the package is a dependency of
 * the web app rather than of the test workspace, so importing it from a test
 * fails to resolve. Aliasing it away changes nothing about the guard where it
 * matters: the web app still depends on the real package, and a client
 * component importing one of these modules still breaks the build.
 */
export {};
