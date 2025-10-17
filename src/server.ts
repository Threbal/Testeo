import 'dotenv/config';
import express, { type Request, type Response } from 'express';
import cors from 'cors';
import { createPool } from 'mysql2/promise';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

// Servir frontend estático
app.use(express.static(path.join(__dirname, '..', 'public')));


// Vars (prefiere DB_*, cae a MYSQL_* si no existen)
const env = process.env;

const DB_HOST = env.DB_HOST || env.MYSQLHOST;
const DB_PORT = Number(env.DB_PORT || env.MYSQLPORT || 3306);
const DB_USER = env.DB_USER || env.MYSQLUSER;
const DB_PASSWORD = env.DB_PASSWORD || env.MYSQLPASSWORD;
const DB_NAME = env.DB_NAME || env.MYSQLDATABASE;
const DB_SSL = env.DB_SSL; // opcional: "true" para forzar

// Detecta si usar SSL
const shouldUseSSL =
  (DB_SSL && DB_SSL.toLowerCase() === 'true') ||
  (!!DB_HOST && /(\.rlwy\.net|railway|proxy)/i.test(DB_HOST));

// Solo añade ssl si hace falta
const pool = createPool({
  host: DB_HOST,
  port: DB_PORT,
  user: DB_USER,
  password: DB_PASSWORD,
  database: DB_NAME,
  waitForConnections: true,
  connectionLimit: 4,
  ...(shouldUseSSL ? { ssl: { rejectUnauthorized: false } } : {})
});

// Boot: crea tablas + seed 3 preguntas
async function boot() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS respondent(
      id INT AUTO_INCREMENT PRIMARY KEY,
      sex TINYINT NOT NULL,
      grade TINYINT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS question(
      question_no INT PRIMARY KEY,
      text_a VARCHAR(255) NOT NULL,
      text_b VARCHAR(255) NOT NULL
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS answer(
      respondent_id INT NOT NULL,
      question_no INT NOT NULL,
      value TINYINT NOT NULL,
      PRIMARY KEY(respondent_id, question_no),
      CONSTRAINT fk_ans_resp FOREIGN KEY (respondent_id) REFERENCES respondent(id) ON DELETE CASCADE,
      CONSTRAINT fk_ans_q    FOREIGN KEY (question_no)  REFERENCES question(question_no) ON DELETE CASCADE
    );
  `);

  const [r] = await pool.query<any[]>(`SELECT COUNT(*) AS n FROM question;`);
  if ((r as any)[0]?.n === 0) {
    await pool.query(`
      INSERT INTO question(question_no,text_a,text_b) VALUES
      (1,'Le gusta matemáticas.','Prefiere diseñar modelos.'),
      (2,'Disfruta laboratorio.','Prefiere leer/escribir.'),
      (3,'Ayudar a personas.','Dirigir equipos.');
    `);
    console.log('Seed ok: 3 preguntas');
  }
  console.log('DB lista');
}

// --- Endpoints mínimos ---

// Health check (con DB)
app.get('/api/health', async (_req: Request, res: Response) => {
  try {
    await pool.query('SELECT 1;');
    res.json({ ok: true, db: 'up' });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Registrar (demo): si no mandan sex/grade, usa valores por defecto
app.post('/api/register', async (req: Request, res: Response) => {
  try {
    const sex = [0, 1].includes(req.body?.sex) ? req.body.sex : 1;
    const grade = [0, 4, 5].includes(req.body?.grade) ? req.body.grade : 4;
    const [r]: any = await pool.query(
      'INSERT INTO respondent(sex,grade) VALUES(?,?)',
      [sex, grade]
    );
    res.json({ respondent_id: r.insertId });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Preguntas (lista todas)
app.get('/api/questions', async (_req: Request, res: Response) => {
  try {
    const [rows] = await pool.query(
      'SELECT question_no,text_a,text_b FROM question ORDER BY question_no;'
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Guardado demo: marca value=1 para todas las preguntas
app.post('/api/submit-demo', async (req: Request, res: Response) => {
  const conn = await pool.getConnection();
  try {
    const respondent_id = Number(req.body?.respondent_id);
    if (!respondent_id) return res.status(400).json({ error: 'respondent_id requerido' });

    const [qs]: any = await conn.query('SELECT question_no FROM question;');
    await conn.beginTransaction();
    for (const q of qs) {
      await conn.query(
        `INSERT INTO answer(respondent_id,question_no,value)
         VALUES(?,?,1)
         ON DUPLICATE KEY UPDATE value=VALUES(value);`,
        [respondent_id, q.question_no]
      );
    }
    await conn.commit();
    res.json({ ok: true, saved: qs.length });
  } catch (e) {
    await conn.rollback();
    res.status(500).json({ error: String(e) });
  } finally {
    conn.release();
  }
});

// Raíz → HTML de prueba
app.get('/', (_req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});
const PORT = Number(process.env.PORT ?? 3000);

// Arrancar
app.listen(PORT, async () => {
  console.log('API escuchando en :' + PORT);
  try { await boot(); } catch (e) { console.error('Boot DB error:', e); }
});
