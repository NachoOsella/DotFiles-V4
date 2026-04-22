# Common CWEs: Vulnerable vs Patched Code Examples

Reference table for the most frequent security weaknesses encountered during code audits. Use these examples to guide remediation across Python, JavaScript/TypeScript, Java, and SQL.

---

## CWE-89: SQL Injection

**Vulnerable (Python):**
```python
query = f"SELECT * FROM users WHERE username = '{user_input}'"
cursor.execute(query)
```

**Patched (Python - parameterized):**
```python
query = "SELECT * FROM users WHERE username = %s"
cursor.execute(query, (user_input,))
```

**Vulnerable (JavaScript/Node.js):**
```javascript
const query = `SELECT * FROM users WHERE username = '${userInput}'`;
db.query(query, callback);
```

**Patched (JavaScript/Node.js - parameterized):**
```javascript
const query = 'SELECT * FROM users WHERE username = ?';
db.query(query, [userInput], callback);
```

**Vulnerable (Java - JDBC):**
```java
String query = "SELECT * FROM users WHERE username = '" + userInput + "'";
Statement stmt = conn.createStatement();
ResultSet rs = stmt.executeQuery(query);
```

**Patched (Java - PreparedStatement):**
```java
String query = "SELECT * FROM users WHERE username = ?";
PreparedStatement pstmt = conn.prepareStatement(query);
pstmt.setString(1, userInput);
ResultSet rs = pstmt.executeQuery();
```

---

## CWE-79: Cross-Site Scripting (XSS)

**Vulnerable (JavaScript/DOM):**
```javascript
element.innerHTML = userInput;
```

**Patched (JavaScript/DOM):**
```javascript
element.textContent = userInput;
```

**Vulnerable (React JSX):**
```jsx
<div dangerouslySetInnerHTML={{ __html: userInput }} />
```

**Patched (React JSX):**
```jsx
<div>{userInput}</div>
```

**Vulnerable (Python - Jinja2 without autoescape):**
```python
from jinja2 import Template
t = Template("<div>{{ data }}</div>")
html = t.render(data=user_input)
```

**Patched (Python - Jinja2 with autoescape):**
```python
from jinja2 import Environment, select_autoescape
env = Environment(autoescape=select_autoescape(['html', 'xml']))
t = env.from_string("<div>{{ data }}</div>")
html = t.render(data=user_input)
```

---

## CWE-78: OS Command Injection

**Vulnerable (Python):**
```python
import os
os.system(f"ping -c 1 {user_input}")
```

**Patched (Python - subprocess with list):**
```python
import subprocess
subprocess.run(["ping", "-c", "1", user_input], capture_output=True, text=True)
```

**Vulnerable (JavaScript/Node.js):**
```javascript
const { exec } = require('child_process');
exec(`ping -c 1 ${userInput}`);
```

**Patched (JavaScript/Node.js - execFile):**
```javascript
const { execFile } = require('child_process');
execFile('ping', ['-c', '1', userInput]);
```

**Vulnerable (Java):**
```java
Runtime.getRuntime().exec("ping -c 1 " + userInput);
```

**Patched (Java - array argument):**
```java
Runtime.getRuntime().exec(new String[]{"ping", "-c", "1", userInput});
```

---

## CWE-22: Path Traversal

**Vulnerable (Python):**
```python
with open(f"/var/data/{filename}", "r") as f:
    data = f.read()
```

**Patched (Python - resolve and validate):**
```python
from pathlib import Path
base = Path("/var/data").resolve()
target = (base / filename).resolve()
if not str(target).startswith(str(base)):
    raise ValueError("Invalid path")
with open(target, "r") as f:
    data = f.read()
```

**Vulnerable (Java):**
```java
File file = new File("/var/data/" + filename);
FileInputStream fis = new FileInputStream(file);
```

**Patched (Java - canonical path check):**
```java
File base = new File("/var/data").getCanonicalFile();
File target = new File(base, filename).getCanonicalFile();
if (!target.getPath().startsWith(base.getPath())) {
    throw new SecurityException("Invalid path");
}
FileInputStream fis = new FileInputStream(target);
```

---

## CWE-312: Cleartext Storage of Sensitive Information

**Vulnerable (Python):**
```python
with open("secrets.txt", "w") as f:
    f.write(api_key)
```

**Patched (Python - environment or keyring):**
```python
import os
# Store in environment variable or secure vault (e.g., keyring, HashiCorp Vault)
os.environ["API_KEY"] = api_key
```

**Vulnerable (JavaScript/Node.js):**
```javascript
fs.writeFileSync('secrets.json', JSON.stringify({ apiKey }));
```

**Patched (JavaScript/Node.js - environment):**
```javascript
// Use environment variables; never commit secrets to disk
const apiKey = process.env.API_KEY;
```

---

## CWE-798: Use of Hard-coded Credentials

**Vulnerable (Python):**
```python
DB_PASSWORD = "SuperSecret123"
```

**Patched (Python):**
```python
import os
DB_PASSWORD = os.getenv("DB_PASSWORD")
if not DB_PASSWORD:
    raise RuntimeError("DB_PASSWORD environment variable is required")
```

**Vulnerable (Java):**
```java
private static final String API_KEY = "sk-live-abc123";
```

**Patched (Java):**
```java
String apiKey = System.getenv("API_KEY");
if (apiKey == null || apiKey.isBlank()) {
    throw new IllegalStateException("API_KEY environment variable is required");
}
```

---

## CWE-352: Cross-Site Request Forgery (CSRF)

**Vulnerable (JavaScript/Express):**
```javascript
app.post('/transfer', (req, res) => {
    // processes transfer without verifying origin
});
```

**Patched (JavaScript/Express - csurf):**
```javascript
const csurf = require('csurf');
const csrfProtection = csurf({ cookie: true });
app.post('/transfer', csrfProtection, (req, res) => {
    // req.csrfToken() validated by middleware
});
```

**Vulnerable (Python - Flask):**
```python
@app.route('/transfer', methods=['POST'])
def transfer():
    # no CSRF token check
    pass
```

**Patched (Python - Flask-WTF):**
```python
from flask_wtf.csrf import CSRFProtect
csrf = CSRFProtect(app)

@app.route('/transfer', methods=['POST'])
@csrf.exempt  # Only if you intend to exempt; normally protected by default
```

---

## CWE-916: Use of Password Hash With Insufficient Computational Effort

**Vulnerable (Python):**
```python
import hashlib
hashed = hashlib.md5(password.encode()).hexdigest()
```

**Patched (Python - bcrypt/argon2):**
```python
import bcrypt
hashed = bcrypt.hashpw(password.encode(), bcrypt.gensalt())
# Verify:
# bcrypt.checkpw(password.encode(), hashed)
```

**Vulnerable (Java):**
```java
MessageDigest md = MessageDigest.getInstance("MD5");
byte[] hash = md.digest(password.getBytes());
```

**Patched (Java - BCrypt):**
```java
import org.mindrot.jbcrypt.BCrypt;
String hashed = BCrypt.hashpw(password, BCrypt.gensalt());
// Verify:
// BCrypt.checkpw(password, hashed);
```

---

## CWE-502: Deserialization of Untrusted Data

**Vulnerable (Python - pickle):**
```python
import pickle
data = pickle.loads(untrusted_bytes)
```

**Patched (Python - JSON):**
```python
import json
data = json.loads(untrusted_bytes.decode())
```

**Vulnerable (Java):**
```java
ObjectInputStream ois = new ObjectInputStream(untrustedStream);
Object obj = ois.readObject();
```

**Patched (Java - JSON/XML with schema validation):**
```java
// Use Jackson with default typing disabled, or protobuf with strict schema
ObjectMapper mapper = new ObjectMapper();
mapper.disableDefaultTyping();
MyClass obj = mapper.readValue(untrustedJson, MyClass.class);
```

---

## CWE-306: Missing Authentication for Critical Function

**Vulnerable (JavaScript/Express):**
```javascript
app.delete('/api/users/:id', (req, res) => {
    User.destroy(req.params.id);
});
```

**Patched (JavaScript/Express):**
```javascript
const authenticate = require('./middleware/authenticate');
const authorize = require('./middleware/authorize');
app.delete('/api/users/:id', authenticate, authorize('admin'), (req, res) => {
    User.destroy(req.params.id);
});
```

**Vulnerable (Python - Flask):**
```python
@app.route('/admin/config', methods=['POST'])
def update_config():
    # no auth check
    pass
```

**Patched (Python - Flask-Login):**
```python
from flask_login import login_required, current_user
from functools import wraps

def admin_required(f):
    @wraps(f)
    @login_required
    def decorated(*args, **kwargs):
        if not current_user.is_admin:
            abort(403)
        return f(*args, **kwargs)
    return decorated

@app.route('/admin/config', methods=['POST'])
@admin_required
def update_config():
    pass
```
