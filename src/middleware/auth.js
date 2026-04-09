import jwt from 'jsonwebtoken';

const SECRET_KEY = process.env.JWT_SECRET || 'sua_chave_secreta_muito_segura_aqui';

export function generateToken(doctor) {
  return jwt.sign(
    { id: doctor.id, email: doctor.email, name: doctor.name },
    SECRET_KEY,
    { expiresIn: '7d' }
  );
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, SECRET_KEY);
  } catch (err) {
    return null;
  }
}

export function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.status(401).json({ error: 'Token não fornecido' });

  const decoded = verifyToken(token);
  if (!decoded) return res.status(403).json({ error: 'Token inválido' });

  req.doctor = decoded;
  next();
}
