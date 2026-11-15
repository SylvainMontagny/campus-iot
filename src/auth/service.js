const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { promisify } = require("node:util");

const scrypt = promisify(crypto.scrypt);
const dataDirectory = path.join(__dirname, "..", "..", "data");
const hashLength = 64;

function validatePassword(password, confirmation) {
  if (typeof password !== "string" || password.length > 256) {
    return "Password must not exceed 256 characters.";
  }
  if (password !== confirmation) return "Password confirmation does not match.";
  return null;
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derivedKey = await scrypt(password, salt, hashLength, { maxmem: 64 * 1024 * 1024 });
  return `scrypt$${salt}$${derivedKey.toString("hex")}`;
}

async function verifyPassword(password, storedHash) {
  const [algorithm, salt, digest, extra] = String(storedHash || "").split("$");
  if (algorithm !== "scrypt" || !/^[a-f0-9]{32}$/.test(salt || "") || !/^[a-f0-9]{128}$/.test(digest || "") || extra !== undefined) {
    return false;
  }
  const expected = Buffer.from(digest, "hex");
  const actual = await scrypt(password, salt, hashLength, { maxmem: 64 * 1024 * 1024 });
  return crypto.timingSafeEqual(actual, expected);
}

async function readPasswordHash(directory = dataDirectory) {
  try {
    const stored = JSON.parse(await fs.readFile(path.join(directory, "auth.json"), "utf8"));
    if (typeof stored.passwordHash !== "string") throw new Error("Authentication file must contain a passwordHash string");
    return stored.passwordHash;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function writePasswordHash(passwordHash, directory = dataDirectory) {
  await fs.mkdir(directory, { recursive: true });
  const filePath = path.join(directory, "auth.json");
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify({ passwordHash })}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true });
    throw error;
  }
}

async function removePasswordHash(directory = dataDirectory) {
  try {
    await fs.unlink(path.join(directory, "auth.json"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

module.exports = { validatePassword, hashPassword, verifyPassword, readPasswordHash, writePasswordHash, removePasswordHash };
