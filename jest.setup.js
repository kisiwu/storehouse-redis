// jest.setup.js
const fs = require('fs');
const path = require('path');

const envPath = path.resolve(process.cwd(), '.env.test');

// Only load dotenv locally if the file actually exists
if (fs.existsSync(envPath)) {
  require('dotenv').config({ path: envPath });
}
