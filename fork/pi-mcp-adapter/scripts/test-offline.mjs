// Compose with the caller's guard; only this process's loopback/IPC listeners are reachable.
import { registerHooks, syncBuiltinESMExports } from "node:module";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import dgram from "node:dgram";

const key = Symbol.for("pi-mcp-adapter.test.offline-guard");
if (!net[key]) {
  const ports = new Set(), paths = new Set();
  const forbidden = () => { throw new Error("Network is forbidden in the MCP offline fixture"); };
  const loopback = (host) => ["localhost", "127.0.0.1", "::1", "[::1]"].includes(host);
  const allowed = (host, port) => loopback(host) && ports.has(Number(port));
  const listen = net.Server.prototype.listen;
  net.Server.prototype.listen = function (...args) {
    this.once("listening", () => {
      const address = this.address();
      if (typeof address === "string") {
        paths.add(address);
        this.once("close", () => paths.delete(address));
      } else if (address) {
        ports.add(address.port);
        this.once("close", () => ports.delete(address.port));
      }
    });
    return listen.apply(this, args);
  };
  const connectionAllowed = (args) => {
    if (Array.isArray(args[0])) args = args[0];
    const options = args[0];
    if (options && typeof options === "object") {
      if (options.path) return paths.has(options.path);
      return allowed(options.host ?? options.hostname ?? "localhost", options.port);
    }
    if (typeof options === "string" && !/^\d+$/.test(options)) return paths.has(options);
    return allowed(typeof args[1] === "string" ? args[1] : "localhost", options);
  };
  const connect = net.connect, createConnection = net.createConnection, tlsConnect = tls.connect;
  const socketConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) { if (!connectionAllowed(args)) return forbidden(); return socketConnect.apply(this, args); };
  net.connect = function (...args) { if (!connectionAllowed(args)) return forbidden(); return connect.apply(this, args); };
  net.createConnection = function (...args) { if (!connectionAllowed(args)) return forbidden(); return createConnection.apply(this, args); };
  tls.connect = function (...args) { if (!connectionAllowed(args)) return forbidden(); return tlsConnect.apply(this, args); };
  const requestAllowed = (input, protocol) => {
    if (typeof input === "string" || input instanceof URL) {
      const url = new URL(input);
      return allowed(url.hostname, url.port || (url.protocol === "https:" ? 443 : 80));
    }
    if (input.socketPath) return paths.has(input.socketPath);
    return allowed(input.hostname ?? input.host ?? "localhost", input.port ?? (protocol === "https:" ? 443 : 80));
  };
  for (const [client, protocol] of [[http, "http:"], [https, "https:"]]) {
    for (const method of ["request", "get"]) {
      const previous = client[method];
      client[method] = function (...args) {
        if (!requestAllowed(args[0], protocol)) return forbidden();
        return previous.apply(this, args);
      };
    }
  }
  const fetch = globalThis.fetch;
  const guardedFetch = async (input, options) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (!allowed(url.hostname, url.port || (url.protocol === "https:" ? 443 : 80))) return forbidden();
    return fetch(input, options);
  };
  dgram.createSocket = forbidden;
  syncBuiltinESMExports();
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier.includes("@napi-rs/keyring") || specifier.endsWith("mcp-keyring-helper.cjs")) {
        throw new Error("OS credentials are forbidden in the MCP offline fixture");
      }
      return nextResolve(specifier, context);
    },
  });
  globalThis.fetch = guardedFetch;
  net[key] = true;
}
