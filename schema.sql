-- Longview D1 schema
CREATE TABLE IF NOT EXISTS fundamentals (
  symbol TEXT PRIMARY KEY,
  data TEXT NOT NULL,           -- normalized JSON (see src/fmp.js normalize)
  updated_at INTEGER NOT NULL   -- unix ms
);
CREATE TABLE IF NOT EXISTS holdings (
  user TEXT NOT NULL,
  symbol TEXT NOT NULL,
  shares REAL NOT NULL,
  cost REAL NOT NULL,           -- average cost per share, in the security's own currency
  PRIMARY KEY (user, symbol)
);
CREATE TABLE IF NOT EXISTS watchlist (
  user TEXT NOT NULL,
  symbol TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (user, symbol)
);
CREATE TABLE IF NOT EXISTS settings (
  user TEXT PRIMARY KEY,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS quotes (
  symbol TEXT PRIMARY KEY,
  data TEXT NOT NULL,           -- normalized quote JSON
  updated_at INTEGER NOT NULL
);
