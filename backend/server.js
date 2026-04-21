const express = require('express');
const path = require('path');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');
const { exec } = require('child_process');
const fs = require('fs');
const os = require('os');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'codecollab-super-secret-key-change-in-production';

// MySQL connection pool (using your new credentials)
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'codecollab2',
  password: process.env.DB_PASSWORD || 'secure2password',
  database: process.env.DB_NAME || 'laesfera',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

app.use(express.json());
app.use(cors());

const frontendPath = path.join(__dirname, '..', 'frontend');
app.use(express.static(frontendPath));

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access token required' });
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token' });
    req.user = user;
    next();
  });
};

// ------------------- CODE EXECUTION SETUP -------------------
const TEMP_DIR = path.join(os.tmpdir(), 'codecollab-run');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

function extractJavaClassName(code) {
  const match = code.match(/public\s+class\s+(\w+)/);
  return match ? match[1] : null;
}

const languageConfigs = {
  javascript: {
    ext: 'js',
    compile: null,
    run: (filename) => `node ${filename}`,
    needCompile: false,
  },
  python: {
    ext: 'py',
    compile: null,
    run: (filename) => {
      const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
      return `${pythonCmd} ${filename}`;
    },
    needCompile: false,
  },
  java: {
    ext: 'java',
    compile: (filename) => `javac ${filename}`,
    run: (className) => `java -cp . ${className}`,
    needCompile: true,
  },
  c: {
    ext: 'c',
    compile: (filename) => {
      const outFile = filename.replace(/\.c$/, '');
      return `gcc ${filename} -o ${outFile}`;
    },
    run: (filename) => {
      const outFile = filename.replace(/\.c$/, '');
      if (process.platform === 'win32') {
        return `.\\${outFile}.exe`;
      }
      return `./${outFile}`;
    },
    needCompile: true,
  },
  plain: {
    ext: 'txt',
    compile: null,
    run: null,
    needCompile: false,
  },
};

// ------------------- AI STATIC ANALYSIS (unchanged) -------------------
function analyzeJavaScript(code) {
  const issues = [];
  const suggestions = [];
  const lines = code.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line && !line.endsWith(';') && !line.endsWith('{') && !line.endsWith('}') && !line.startsWith('//') && !line.startsWith('/*') && !line.endsWith(')') && !line.includes('function') && !line.includes('if') && !line.includes('for') && !line.includes('while')) {
      suggestions.push(`Line ${i+1}: Missing semicolon (not critical but good practice).`);
      break;
    }
  }
  if (code.includes('var ')) suggestions.push('Prefer `let` or `const` over `var` for better scoping.');
  if (code.includes('==') && !code.includes('===')) issues.push('Using `==` can lead to type coercion bugs. Consider using `===` for strict equality.');
  if (code.match(/function\s+\w+\s*\([^)]*\)\s*{/) && !code.includes('return')) suggestions.push('Function does not return a value – if it should return something, add a `return` statement.');
  if (!code.includes('console.log') && (code.includes('function') || code.includes('class'))) suggestions.push('No output method (e.g., console.log) – you may not see any results when running.');
  return { issues, suggestions };
}

function analyzePython(code) {
  const issues = [];
  const suggestions = [];
  if (code.includes('input(')) suggestions.push('The code uses `input()` which will wait for user input – the execution environment has a timeout, so consider removing or mocking it for testing.');
  if (code.includes('print ') && !code.includes('print(')) issues.push('Incorrect print syntax. Use `print(...)` as a function (Python 3).');
  if (code.match(/^\s*if\s+[^:]+$/m) && !code.includes(':')) issues.push('Missing colon (`:`) after if/else/for/while statement.');
  if (code.includes('range(') && !code.includes('for')) suggestions.push('`range()` is typically used in a `for` loop – did you forget the loop?');
  if (!code.includes('def') && !code.includes('class') && code.includes('=')) suggestions.push('You have variable assignments but no output – add `print()` to see results.');
  return { issues, suggestions };
}

function analyzeJava(code) {
  const issues = [];
  const suggestions = [];
  if (!code.includes('public class')) issues.push('Java code must declare a public class with the same name as the file (e.g., `public class MyClass`).');
  if (code.includes('public static void main') && !code.includes('System.out.println')) suggestions.push('Your main method does not print anything – add `System.out.println()` to see output.');
  if (code.includes('Scanner') && !code.includes('import java.util.Scanner')) issues.push('`Scanner` used but `import java.util.Scanner;` is missing.');
  if (code.match(/catch\s*\(/) && !code.includes('catch (')) issues.push('Syntax error in catch block. Use `catch (Exception e) { ... }`.');
  return { issues, suggestions };
}

function analyzeC(code) {
  const issues = [];
  const suggestions = [];
  if (!code.includes('#include <stdio.h>') && (code.includes('printf') || code.includes('scanf'))) issues.push('Missing `#include <stdio.h>` for printf/scanf functions.');
  if (code.includes('int main') && !code.includes('return 0')) suggestions.push('`main` function should return an integer (usually `return 0;`).');
  if (code.includes('=') && code.includes('==') === false && code.match(/if\s*\([^=]*=[^=]/)) issues.push('Possible assignment `=` inside if condition. Did you mean `==`?');
  return { issues, suggestions };
}

// ------------------- AI DEBUG (RUN + EXPLAIN) -------------------
function explainError(errorMsg, language) {
  const lower = errorMsg.toLowerCase();
  if (lower.includes('syntaxerror')) return 'Syntax error: check for missing brackets, parentheses, or quotes.';
  if (lower.includes('referenceerror')) return 'ReferenceError: you are using a variable that has not been defined.';
  if (lower.includes('typeerror')) return 'TypeError: you are trying to use a value of the wrong type (e.g., calling something that is not a function).';
  if (lower.includes('cannot find module')) return 'Module not found: you are trying to import a package that is not installed.';
  if (lower.includes('unexpected token')) return 'Unexpected token: there is a typo or invalid character in your code.';
  if (lower.includes('indentationerror') && language === 'python') return 'IndentationError: Python relies on consistent indentation (spaces/tabs).';
  if (lower.includes('valueerror')) return 'ValueError: a function received an argument of the right type but inappropriate value.';
  if (lower.includes('indexerror')) return 'IndexError: you are trying to access an array/list index that does not exist.';
  if (lower.includes('keyerror')) return 'KeyError: you tried to access a dictionary key that does not exist.';
  if (lower.includes('classnotfound') && language === 'java') return 'ClassNotFoundException: make sure your public class name matches the filename.';
  if (lower.includes('cannot find symbol') && language === 'java') return 'Cannot find symbol: you may have misspelled a variable or method name, or forgot an import.';
  if (lower.includes('undefined reference') && language === 'c') return 'Undefined reference: you declared a function but did not define it, or forgot to link a library.';
  return `Error: ${errorMsg}`;
}

app.post('/api/ai-debug', async (req, res) => {
  const { code, language } = req.body;
  if (!code) return res.status(400).json({ error: 'No code provided' });

  const config = languageConfigs[language];
  if (!config) return res.status(400).json({ error: `Unsupported language: ${language}` });
  if (!config.run && language !== 'java') return res.status(400).json({ error: `Execution not supported for language: ${language}` });

  let tempFile, className = null;
  if (language === 'java') {
    className = extractJavaClassName(code);
    if (!className) return res.status(400).json({ error: 'Java code must declare a public class.' });
    tempFile = path.join(TEMP_DIR, `${className}.java`);
  } else {
    const sessionId = uuidv4();
    tempFile = path.join(TEMP_DIR, `${sessionId}.${config.ext}`);
  }
  const dir = path.dirname(tempFile);
  const fileName = path.basename(tempFile);

  let output = '', error = null;

  try {
    fs.writeFileSync(tempFile, code);
    if (config.needCompile) {
      let compileCmd;
      if (language === 'java') compileCmd = config.compile(fileName);
      else if (language === 'c') compileCmd = config.compile(fileName);
      await new Promise((resolve, reject) => {
        exec(compileCmd, { cwd: dir, timeout: 10000 }, (err, stdout, stderr) => {
          if (err) reject(new Error(stderr || stdout || err.message));
          else resolve();
        });
      });
    }
    let runCmd;
    if (language === 'java') runCmd = config.run(className);
    else runCmd = config.run(fileName);
    output = await new Promise((resolve, reject) => {
      exec(runCmd, { cwd: dir, timeout: 5000 }, (err, stdout, stderr) => {
        if (err) reject(new Error(stderr || stdout || err.message));
        else resolve(stdout);
      });
    });
  } catch (err) {
    error = err.message;
  } finally {
    try { fs.unlinkSync(tempFile); } catch(e) {}
    if (language === 'c') {
      const outFile = tempFile.replace(/\.c$/, '');
      try { fs.unlinkSync(outFile); } catch(e) {}
      if (process.platform === 'win32') try { fs.unlinkSync(`${outFile}.exe`); } catch(e) {}
    }
    if (language === 'java') {
      const classFile = path.join(dir, `${className}.class`);
      try { fs.unlinkSync(classFile); } catch(e) {}
    }
  }

  if (error) {
    const explanation = explainError(error, language);
    res.json({
      success: false,
      error: error,
      explanation: explanation,
      suggestions: [
        'Check the error message above for details.',
        'Review the line numbers mentioned in the error.',
        'Try running the code locally to see more context.'
      ]
    });
  } else {
    let staticReview = { issues: [], suggestions: [] };
    switch (language) {
      case 'javascript': staticReview = analyzeJavaScript(code); break;
      case 'python': staticReview = analyzePython(code); break;
      case 'java': staticReview = analyzeJava(code); break;
      case 'c': staticReview = analyzeC(code); break;
    }
    res.json({
      success: true,
      output: output || '(no output)',
      issues: staticReview.issues,
      suggestions: staticReview.suggestions,
      message: staticReview.issues.length === 0 && staticReview.suggestions.length === 0
        ? '✅ Code executed successfully and looks clean!'
        : '⚡ Code ran successfully, but here are some improvements:'
    });
  }
});

// ------------------- DATABASE INIT (MySQL) -------------------
const initDb = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS userss (
        id INT PRIMARY KEY AUTO_INCREMENT,
        username VARCHAR(100) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS snippets (
        id INT PRIMARY KEY AUTO_INCREMENT,
        title VARCHAR(255) NOT NULL,
        language VARCHAR(50) NOT NULL,
        tags JSON DEFAULT NULL,
        code TEXT NOT NULL,
        created_by INT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (created_by) REFERENCES userss(id) ON DELETE SET NULL
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS comments (
        id INT PRIMARY KEY AUTO_INCREMENT,
        snippet_id INT NOT NULL,
        line_number INT NOT NULL,
        user_id INT,
        username VARCHAR(100) NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (snippet_id) REFERENCES snippets(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES userss(id) ON DELETE SET NULL
      )
    `);
    console.log('✅ MySQL ready (tables: userss, snippets, comments)');

    const [rows] = await pool.query('SELECT COUNT(*) as count FROM snippets');
    if (rows[0].count === 0) {
      const sampleSnippets = [
        {
          title: 'QuickSort Implementation',
          language: 'javascript',
          tags: JSON.stringify(['algorithm', 'sort']),
          code: `function quickSort(arr) {\n  if (arr.length <= 1) return arr;\n  const pivot = arr[0];\n  const left = [];\n  const right = [];\n  for (let i = 1; i < arr.length; i++) {\n    arr[i] < pivot ? left.push(arr[i]) : right.push(arr[i]);\n  }\n  return [...quickSort(left), pivot, ...quickSort(right)];\n}\n\nconsole.log(quickSort([3,6,8,10,1,2,1]));`,
          created_by: null
        },
        {
          title: 'Flask Hello World',
          language: 'python',
          tags: JSON.stringify(['flask', 'web']),
          code: `from flask import Flask\napp = Flask(__name__)\n\n@app.route('/')\ndef hello():\n    return 'Hello, World!'\n\nif __name__ == '__main__':\n    app.run(debug=True)`,
          created_by: null
        },
        {
          title: 'Binary Search (Java)',
          language: 'java',
          tags: JSON.stringify(['algorithm', 'search']),
          code: `public class BinarySearch {\n    public static int binarySearch(int[] arr, int target) {\n        int left = 0, right = arr.length - 1;\n        while (left <= right) {\n            int mid = left + (right - left) / 2;\n            if (arr[mid] == target) return mid;\n            if (arr[mid] < target) left = mid + 1;\n            else right = mid - 1;\n        }\n        return -1;\n    }\n\n    public static void main(String[] args) {\n        int[] arr = {1, 2, 3, 4, 5};\n        System.out.println(binarySearch(arr, 3));\n    }\n}`,
          created_by: null
        }
      ];
      for (const s of sampleSnippets) {
        await pool.query(
          'INSERT INTO snippets (title, language, tags, code, created_by) VALUES (?, ?, ?, ?, ?)',
          [s.title, s.language, s.tags, s.code, s.created_by]
        );
      }
      console.log('🌱 Seeded 3 sample snippets (public)');
    }
  } catch (err) {
    console.error('❌ DB init error:', err.message);
  }
};

// ------------------- AUTH ROUTES -------------------
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (username.length < 3) return res.status(400).json({ error: 'Username too short' });
  if (password.length < 4) return res.status(400).json({ error: 'Password too short' });

  try {
    const [existing] = await pool.query('SELECT id FROM userss WHERE username = ?', [username]);
    if (existing.length) return res.status(409).json({ error: 'Username taken' });

    const hashed = await bcrypt.hash(password, 10);
    const [result] = await pool.query('INSERT INTO userss (username, password) VALUES (?, ?)', [username, hashed]);
    res.status(201).json({ message: 'User registered', user: { id: result.insertId, username } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  try {
    const [rows] = await pool.query('SELECT id, username, password FROM userss WHERE username = ?', [username]);
    const user = rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign(
      { id: user.id, username: user.username, exp: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60 },
      JWT_SECRET
    );
    res.json({ message: 'Login successful', token, user: { id: user.id, username: user.username } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/me', authenticateToken, (req, res) => {
  res.json({ user: req.user });
});

// ------------------- SNIPPET ROUTES (MySQL) -------------------
app.get('/api/snippets', async (req, res) => {
  try {
    const { search, tag } = req.query;
    let query = `
      SELECT s.*, COUNT(c.id) as commentCount
      FROM snippets s
      LEFT JOIN comments c ON s.id = c.snippet_id
    `;
    const params = [];
    const conditions = [];

    if (search) {
      conditions.push(`(s.title LIKE ? OR s.code LIKE ? OR JSON_SEARCH(s.tags, 'all', ?) IS NOT NULL)`);
      const like = `%${search}%`;
      params.push(like, like, `%${search}%`);
    }
    if (tag) {
      conditions.push(`JSON_SEARCH(s.tags, 'one', ?) IS NOT NULL`);
      params.push(tag);
    }
    if (conditions.length) {
      query += ' WHERE ' + conditions.join(' AND ');
    }
    query += ' GROUP BY s.id ORDER BY s.created_at DESC';
    const [rows] = await pool.query(query, params);
    rows.forEach(row => {
      if (row.tags) {
        try { row.tags = JSON.parse(row.tags); } catch(e) { row.tags = []; }
      } else { row.tags = []; }
    });
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/snippets/:id', async (req, res) => {
  try {
    const snippetId = parseInt(req.params.id);
    const [snippetRows] = await pool.query('SELECT * FROM snippets WHERE id = ?', [snippetId]);
    if (snippetRows.length === 0) return res.status(404).json({ error: 'Snippet not found' });
    const snippet = snippetRows[0];
    if (snippet.tags) {
      try { snippet.tags = JSON.parse(snippet.tags); } catch(e) { snippet.tags = []; }
    } else { snippet.tags = []; }
    const [commentRows] = await pool.query('SELECT * FROM comments WHERE snippet_id = ? ORDER BY created_at ASC', [snippetId]);
    res.json({ snippet, comments: commentRows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// FIXED: SNIPPET CREATION WITH BETTER ERROR HANDLING
app.post('/api/snippets', authenticateToken, async (req, res) => {
  const { title, language, tags, code } = req.body;
  if (!title || !language || !code) {
    return res.status(400).json({ error: 'Title, language, and code are required' });
  }
  try {
    // Ensure tags is a comma-separated string from frontend; convert to array then JSON
    let tagArray = [];
    if (tags) {
      if (typeof tags === 'string') {
        tagArray = tags.split(',').map(t => t.trim()).filter(Boolean);
      } else if (Array.isArray(tags)) {
        tagArray = tags;
      }
    }
    const tagJson = JSON.stringify(tagArray);
    const [result] = await pool.query(
      'INSERT INTO snippets (title, language, tags, code, created_by) VALUES (?, ?, ?, ?, ?)',
      [title, language, tagJson, code, req.user.id]
    );
    const [newSnippet] = await pool.query('SELECT * FROM snippets WHERE id = ?', [result.insertId]);
    if (newSnippet[0].tags) {
      try { newSnippet[0].tags = JSON.parse(newSnippet[0].tags); } catch(e) { newSnippet[0].tags = []; }
    } else {
      newSnippet[0].tags = [];
    }
    res.status(201).json(newSnippet[0]);
  } catch (err) {
    console.error('Snippet creation error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

app.put('/api/snippets/:id', authenticateToken, async (req, res) => {
  const snippetId = parseInt(req.params.id);
  const { title, language, tags, code } = req.body;
  try {
    const [existing] = await pool.query('SELECT created_by FROM snippets WHERE id = ?', [snippetId]);
    if (existing.length === 0) return res.status(404).json({ error: 'Snippet not found' });
    if (existing[0].created_by !== req.user.id) {
      return res.status(403).json({ error: 'You can only edit your own snippets' });
    }
    let tagArray = [];
    if (tags) {
      if (typeof tags === 'string') {
        tagArray = tags.split(',').map(t => t.trim()).filter(Boolean);
      } else if (Array.isArray(tags)) {
        tagArray = tags;
      }
    }
    const tagJson = JSON.stringify(tagArray);
    await pool.query(
      'UPDATE snippets SET title = ?, language = ?, tags = ?, code = ? WHERE id = ?',
      [title, language, tagJson, code, snippetId]
    );
    const [updated] = await pool.query('SELECT * FROM snippets WHERE id = ?', [snippetId]);
    if (updated[0].tags) {
      try { updated[0].tags = JSON.parse(updated[0].tags); } catch(e) { updated[0].tags = []; }
    } else {
      updated[0].tags = [];
    }
    res.json(updated[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/snippets/:id', authenticateToken, async (req, res) => {
  const snippetId = parseInt(req.params.id);
  try {
    const [existing] = await pool.query('SELECT created_by FROM snippets WHERE id = ?', [snippetId]);
    if (existing.length === 0) return res.status(404).json({ error: 'Snippet not found' });
    if (existing[0].created_by !== req.user.id) {
      return res.status(403).json({ error: 'You can only delete your own snippets' });
    }
    await pool.query('DELETE FROM snippets WHERE id = ?', [snippetId]);
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ------------------- COMMENT ROUTES -------------------
app.post('/api/comments', authenticateToken, async (req, res) => {
  const { snippetId, lineNumber, content } = req.body;
  if (!snippetId || lineNumber === undefined || !content) {
    return res.status(400).json({ error: 'snippetId, lineNumber, and content are required' });
  }
  try {
    const [snippetCheck] = await pool.query('SELECT id FROM snippets WHERE id = ?', [snippetId]);
    if (snippetCheck.length === 0) return res.status(404).json({ error: 'Snippet not found' });
    const [result] = await pool.query(
      'INSERT INTO comments (snippet_id, line_number, user_id, username, content) VALUES (?, ?, ?, ?, ?)',
      [snippetId, lineNumber, req.user.id, req.user.username, content]
    );
    const [newComment] = await pool.query('SELECT * FROM comments WHERE id = ?', [result.insertId]);
    res.status(201).json(newComment[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/comments/:snippetId', async (req, res) => {
  try {
    const snippetId = parseInt(req.params.snippetId);
    const [rows] = await pool.query('SELECT * FROM comments WHERE snippet_id = ? ORDER BY created_at ASC', [snippetId]);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/comments/:id', authenticateToken, async (req, res) => {
  const commentId = parseInt(req.params.id);
  try {
    const [comment] = await pool.query(
      `SELECT c.*, s.created_by as snippet_owner
       FROM comments c
       JOIN snippets s ON c.snippet_id = s.id
       WHERE c.id = ?`,
      [commentId]
    );
    if (comment.length === 0) return res.status(404).json({ error: 'Comment not found' });
    const isOwner = comment[0].user_id === req.user.id;
    const isSnippetOwner = comment[0].snippet_owner === req.user.id;
    if (!isOwner && !isSnippetOwner) {
      return res.status(403).json({ error: 'You can only delete your own comments or comments on your snippets' });
    }
    await pool.query('DELETE FROM comments WHERE id = ?', [commentId]);
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ------------------- CODE EXECUTION ROUTE (for "Run Code") -------------------
app.post('/api/run', async (req, res) => {
  const { code, language } = req.body;
  if (!code) return res.status(400).json({ error: 'No code provided' });
  const config = languageConfigs[language];
  if (!config) return res.status(400).json({ error: `Unsupported language: ${language}` });
  if (!config.run && language !== 'java') return res.status(400).json({ error: `Execution not supported for language: ${language}` });

  let tempFile, className = null;
  if (language === 'java') {
    className = extractJavaClassName(code);
    if (!className) return res.status(400).json({ error: 'Java code must declare a public class (e.g., public class MyClass)' });
    tempFile = path.join(TEMP_DIR, `${className}.java`);
  } else {
    const sessionId = uuidv4();
    tempFile = path.join(TEMP_DIR, `${sessionId}.${config.ext}`);
  }
  const dir = path.dirname(tempFile);
  const fileName = path.basename(tempFile);

  try {
    fs.writeFileSync(tempFile, code);
    if (config.needCompile) {
      let compileCmd;
      if (language === 'java') compileCmd = config.compile(fileName);
      else if (language === 'c') compileCmd = config.compile(fileName);
      await new Promise((resolve, reject) => {
        exec(compileCmd, { cwd: dir, timeout: 10000 }, (error, stdout, stderr) => {
          if (error) reject(new Error(stderr || stdout || error.message));
          else resolve();
        });
      });
    }
    let runCmd;
    if (language === 'java') runCmd = config.run(className);
    else runCmd = config.run(fileName);
    const output = await new Promise((resolve, reject) => {
      exec(runCmd, { cwd: dir, timeout: 5000 }, (error, stdout, stderr) => {
        if (error) reject(new Error(stderr || stdout || error.message));
        else resolve(stdout);
      });
    });
    // Cleanup
    try { fs.unlinkSync(tempFile); } catch(e) {}
    if (language === 'c') {
      const outFile = tempFile.replace(/\.c$/, '');
      try { fs.unlinkSync(outFile); } catch(e) {}
      if (process.platform === 'win32') try { fs.unlinkSync(`${outFile}.exe`); } catch(e) {}
    }
    if (language === 'java') {
      const classFile = path.join(dir, `${className}.class`);
      try { fs.unlinkSync(classFile); } catch(e) {}
    }
    res.json({ output: output || '(no output)' });
  } catch (err) {
    try { fs.unlinkSync(tempFile); } catch(e) {}
    if (language === 'c') {
      const outFile = tempFile.replace(/\.c$/, '');
      try { fs.unlinkSync(outFile); } catch(e) {}
      if (process.platform === 'win32') try { fs.unlinkSync(`${outFile}.exe`); } catch(e) {}
    }
    if (language === 'java') {
      const classFile = path.join(dir, `${className}.class`);
      try { fs.unlinkSync(classFile); } catch(e) {}
    }
    res.json({ error: err.message });
  }
});

// ------------------- CATCH-ALL FOR FRONTEND -------------------
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api')) {
    res.sendFile(path.join(frontendPath, 'index.html'));
  } else {
    next();
  }
});

// ------------------- START SERVER -------------------
const start = async () => {
  await initDb();
  app.listen(PORT, () => {
    console.log(`🚀 Server running at http://localhost:${PORT}`);
    console.log(`📁 Serving frontend from: ${frontendPath}`);
  });
};
start();