const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

require('dotenv').config();

const dbPath = path.resolve(process.env.SQLITE_PATH || './data/whatfood.sqlite');

fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new DatabaseSync(dbPath);

db.exec('PRAGMA foreign_keys = ON');

module.exports = db;