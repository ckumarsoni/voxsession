"use strict";
require("dotenv").config();

const express    = require("express");
const http       = require("http");
const { Server } = require("socket.io");
const path       = require("path");
const fs         = require("fs");
const multer     = require("multer");
const bcrypt     = require("bcryptjs");
const jwt        = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");
const cors       = require("cors");
const helmet     = require("helmet");
const morgan     = require("morgan");
const rateLimit  = require("express-rate-limit");
const db         = require("./database");
const cfg        = require("./config");

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin:"*", methods:["GET","POST"] },
  maxHttpBufferSize: 30e6,
  transports: ["websocket","polling"],
});

const AUDIO_DIR = path.join(__dirname, "..", "public", "audio");
const WEB_DIR   = path.join(__dirname, "..", "public", "web");
[AUDIO_DIR, WEB_DIR, path.join(AUDIO_DIR,"admin")].forEach(d => fs.mkdirSync(d,{ recursive:true }));

app.use(helmet({ contentSecurityPolicy:false }));
app.use(cors());
app.use(morgan("dev"));
app.use(express.json({ limit:"10mb" }));
app.use(express.urlencoded({ extended:true }));
app.use("/public", express.static(path.join(__dirname,"..", "public")));
app.use(express.static(WEB_DIR));
app.use("/api/", rateLimit({ windowMs:15*60*1000, max:500 }));

// Multer — user audio
const userStorage = multer.diskStorage({
  destination:(req,file,cb) => { const d=path.join(AUDIO_DIR,req.user?.id||"unknown"); fs.mkdirSync(d,{recursive:true}); cb(null,d); },
  filename:(req,file,cb) => { cb(null,`${Date.now()}_${uuidv4().substr(0,8)}.${file.originalname.split(".").pop()||"webm"}`); },
});
const userUpload = multer({ storage:userStorage, limits:{ fileSize:60*1024*1024 } });

// Multer — admin broadcast recordings
const adminStorage = multer.diskStorage({
  destination:(req,file,cb) => { const d=path.join(AUDIO_DIR,"admin"); fs.mkdirSync(d,{recursive:true}); cb(null,d); },
  filename:(req,file,cb) => { cb(null,`${Date.now()}_${uuidv4().substr(0,8)}.${file.originalname.split(".").pop()||"webm"}`); },
});
const adminUpload = multer({ storage:adminStorage, limits:{ fileSize:200*1024*1024 } });

// Auth
function auth(req,res,next) {
  const token=req.headers.authorization?.split(" ")[1];
  if(!token) return res.status(401).json({ error:"No token" });
  try { req.user=jwt.verify(token,cfg.JWT_SECRET); next(); }
  catch { res.status(401).json({ error:"Invalid token" }); }
}
function adminOnly(req,res,next) {
  if(req.user?.role!=="admin") return res.status(403).json({ error:"Admin only" });
  next();
}

// ── AUTH ──────────────────────────────────────────────────────────────────────
app.post("/api/auth/login", (req,res) => {
  const { userId,password }=req.body;
  const id=(userId||"").trim().toUpperCase();
  if(!id||!password) return res.status(400).json({ error:"Missing fields" });
  if(id==="ADMIN") {
    if(password!==cfg.ADMIN_PASSWORD) return res.status(401).json({ error:"Invalid credentials" });
    const token=jwt.sign({ id:"ADMIN",name:"Administrator",role:"admin",avatar:"AD",color:"purple" },cfg.JWT_SECRET,{ expiresIn:"24h" });
    return res.json({ token, user:{ id:"ADMIN",name:"Administrator",role:"admin",avatar:"AD",color:"purple" } });
  }
  const user=db.getUserById(id);
  if(!user||!bcrypt.compareSync(password,user.password_hash)) return res.status(401).json({ error:"Invalid credentials" });
  const token=jwt.sign({ id:user.id,name:user.name,role:"user",avatar:user.avatar,color:user.color },cfg.JWT_SECRET,{ expiresIn:"24h" });
  res.json({ token, user:{ id:user.id,name:user.name,role:"user",avatar:user.avatar,color:user.color } });
});

// ── USERS ─────────────────────────────────────────────────────────────────────
app.get("/api/users", auth, adminOnly, (req,res) => res.json(db.getAllUsers()));
app.post("/api/users", auth, adminOnly, (req,res) => {
  const { name,userId,password }=req.body;
  if(!name||!userId||!password) return res.status(400).json({ error:"Missing fields" });
  const id=userId.trim().toUpperCase();
  if(id==="ADMIN"||db.getUserById(id)) return res.status(409).json({ error:"User ID taken" });
  const colors=["blue","orange","green","purple","cyan"];
  const avatar=name.split(" ").map(w=>w[0]).join("").slice(0,2).toUpperCase();
  const color=colors[db.getUserCount()%colors.length];
  db.createUser({ id,name,password_hash:bcrypt.hashSync(password,10),avatar,color });
  fs.mkdirSync(path.join(AUDIO_DIR,id),{ recursive:true });
  const u=db.getUserById(id);
  io.emit("user_added",{ id:u.id,name:u.name,avatar:u.avatar,color:u.color });
  res.status(201).json({ id:u.id,name:u.name,avatar:u.avatar,color:u.color });
});
app.delete("/api/users/:id", auth, adminOnly, (req,res) => {
  const id=req.params.id.toUpperCase();
  if(!db.getUserById(id)) return res.status(404).json({ error:"Not found" });
  db.deleteUser(id);
  io.emit("user_removed",{ id });
  res.json({ success:true });
});

// ── SESSIONS ──────────────────────────────────────────────────────────────────
app.get("/api/sessions",        auth, (req,res) => res.json(req.user.role==="admin"?db.getAllSessions():db.getUserSessions(req.user.id)));
app.get("/api/sessions/active", auth, (req,res) => res.json(db.getActiveSession()));
app.get("/api/sessions/:id/messages", auth, (req,res) => {
  const msgs=db.getSessionMessages(req.params.id);
  res.json(msgs.map(m=>({ ...m, audio_url:`/public/audio/${m.user_id}/${m.audio_filename}` })));
});
app.post("/api/sessions", auth, adminOnly, (req,res) => {
  const { title }=req.body;
  if(!title) return res.status(400).json({ error:"Title required" });
  const active=db.getActiveSession();
  if(active) db.endSession(active.id);
  const id=uuidv4();
  db.createSession({ id,title });
  const sess=db.getSessionById(id);
  io.emit("session_started",sess);
  res.status(201).json(sess);
});
app.put("/api/sessions/:id/end", auth, adminOnly, (req,res) => {
  const sess=db.getSessionById(req.params.id);
  if(!sess) return res.status(404).json({ error:"Not found" });
  db.endSession(req.params.id);
  const updated=db.getSessionById(req.params.id);
  io.emit("session_ended",updated);
  res.json(updated);
});

// ── MESSAGES ──────────────────────────────────────────────────────────────────
app.get("/api/messages", auth, (req,res) => {
  const { date }=req.query;
  const msgs=req.user.role==="admin"?db.getAllMessages(date):db.getUserMessages(req.user.id,date);
  res.json(msgs.map(m=>({ ...m, audio_url:`/public/audio/${m.user_id}/${m.audio_filename}` })));
});
app.get("/api/messages/dates", auth, (req,res) => {
  res.json(req.user.role==="admin"?db.getAllMessageDates():db.getUserMessageDates(req.user.id));
});
app.post("/api/messages/upload", auth, userUpload.single("audio"), (req,res) => {
  if(!req.file) return res.status(400).json({ error:"No audio" });
  const { sessionId,duration,replyToId }=req.body;
  const session=db.getSessionById(sessionId);
  if(!session||session.ended_at) { fs.unlinkSync(req.file.path); return res.status(400).json({ error:"Session not active" }); }
  const u=req.user;
  const id=uuidv4();
  const isAdminReply=u.role==="admin"&&!!replyToId;
  db.createMessage({ id,session_id:sessionId,user_id:u.id,user_name:u.name,avatar:u.avatar||"AD",color:u.color||"purple",is_admin_reply:isAdminReply,reply_to_id:replyToId||null,audio_filename:req.file.filename,duration:parseFloat(duration)||0,file_size:req.file.size });
  const msg={ ...db.getMessageById(id), audio_url:`/public/audio/${u.id}/${req.file.filename}` };
  io.emit("new_message",msg);
  if(isAdminReply) {
    const original=db.getMessageById(replyToId);
    if(original) io.emit("admin_reply_notification",{ replyId:id,replyToId,targetUserId:original.user_id,adminName:u.name });
  }
  res.status(201).json(msg);
});

// ── ADMIN BROADCAST RECORDINGS ─────────────────────────────────────────────────
app.post("/api/admin/recording/upload", auth, adminOnly, adminUpload.single("audio"), (req,res) => {
  if(!req.file) return res.status(400).json({ error:"No audio" });
  const { sessionId,duration }=req.body;
  const session=db.getSessionById(sessionId);
  if(!session) { fs.unlinkSync(req.file.path); return res.status(400).json({ error:"Session not found" }); }
  const id=uuidv4();
  db.createAdminRecording({ id, session_id:sessionId, audio_filename:req.file.filename, duration:parseFloat(duration)||0, file_size:req.file.size });
  const rec={ ...db.getAllAdminRecordings().find(r=>r.id===id), audio_url:`/public/audio/admin/${req.file.filename}` };
  res.status(201).json(rec);
});
app.get("/api/admin/recordings", auth, adminOnly, (req,res) => {
  const { sessionId }=req.query;
  const recs=sessionId?db.getSessionAdminRecordings(sessionId):db.getAllAdminRecordings();
  res.json(recs.map(r=>({ ...r, audio_url:`/public/audio/admin/${r.audio_filename}` })));
});

// Protected audio
app.get("/public/audio/:userId/:filename", auth, (req,res) => {
  const { userId,filename }=req.params;
  if(req.user.role!=="admin"&&req.user.id!==userId) return res.status(403).json({ error:"Forbidden" });
  const fp=path.join(AUDIO_DIR,userId,filename);
  if(!fs.existsSync(fp)) return res.status(404).send("Not found");
  res.sendFile(fp);
});
app.get("/api/stats", auth, adminOnly, (req,res) => res.json(db.getStats()));

app.get("*", (req,res) => {
  const indexPath=path.join(WEB_DIR,"index.html");
  if(fs.existsSync(indexPath)) res.sendFile(indexPath);
  else res.status(404).send("App not found");
});

// ═════════════════════════════════════════════════════════════════════════════
//  SOCKET.IO — WebRTC Signaling + Real-time
// ═════════════════════════════════════════════════════════════════════════════
const onlineUsers  = new Map();  // socketId → userObj
const speaking     = new Set();  // userIds currently speaking
const socketByUser = new Map();  // userId → socketId (latest)

io.use((socket,next) => {
  try { socket.user=jwt.verify(socket.handshake.auth?.token,cfg.JWT_SECRET); next(); }
  catch { next(new Error("Auth failed")); }
});

io.on("connection", socket => {
  const u = socket.user;
  onlineUsers.set(socket.id, u);
  socketByUser.set(u.id, socket.id);
  console.log(`[+] ${u.name} (${u.role}) | online: ${onlineUsers.size}`);

  // Send current state to new connection
  socket.emit("init_state", {
    session:      db.getActiveSession(),
    onlineUsers:  [...new Map([...onlineUsers.values()].map(x=>[x.id,x])).values()],
    speakingUsers:[...speaking],
  });
  socket.broadcast.emit("user_online", { id:u.id, name:u.name, role:u.role, avatar:u.avatar, color:u.color });

  // Join session
  socket.on("join_session", ({ sessionId }) => {
    const sess=db.getSessionById(sessionId);
    if(!sess||sess.ended_at) return;
    db.joinSession(sessionId,u.id);
    socket.join(`sess:${sessionId}`);
    io.emit("user_joined_session", { sessionId,userId:u.id,userName:u.name,avatar:u.avatar,color:u.color });
    console.log(`[JOIN] ${u.name} → session ${sess.title}`);
  });

  // Speaking indicators
  socket.on("speaking_start", () => { speaking.add(u.id); io.emit("user_speaking",{ userId:u.id,speaking:true }); });
  socket.on("speaking_stop",  () => { speaking.delete(u.id); io.emit("user_speaking",{ userId:u.id,speaking:false }); });

  // ── WebRTC SIGNALING ────────────────────────────────────────────────────────
  // Admin starts broadcast → tells all users to connect
  socket.on("webrtc:admin_broadcast_start", ({ sessionId }) => {
    if(u.role!=="admin") return;
    console.log(`[WebRTC] Admin broadcast START — session ${sessionId}`);
    socket.to(`sess:${sessionId}`).emit("webrtc:admin_broadcast_start", { adminSocketId:socket.id });
    io.emit("admin_broadcasting", { broadcasting:true });
  });

  socket.on("webrtc:admin_broadcast_stop", ({ sessionId }) => {
    if(u.role!=="admin") return;
    console.log(`[WebRTC] Admin broadcast STOP`);
    io.emit("admin_broadcasting", { broadcasting:false });
  });

  // User sends offer to admin
  socket.on("webrtc:offer", ({ to, offer, from }) => {
    const targetSocketId = socketByUser.get(to) || to;
    io.to(targetSocketId).emit("webrtc:offer", { from:u.id, fromSocketId:socket.id, offer });
  });

  // Admin sends answer back to user
  socket.on("webrtc:answer", ({ to, answer }) => {
    const targetSocketId = socketByUser.get(to) || to;
    io.to(targetSocketId).emit("webrtc:answer", { from:u.id, answer });
  });

  // ICE candidates exchange
  socket.on("webrtc:ice", ({ to, candidate }) => {
    const targetSocketId = socketByUser.get(to) || to;
    io.to(targetSocketId).emit("webrtc:ice", { from:u.id, fromSocketId:socket.id, candidate });
  });

  // Admin requests user to initiate WebRTC connection
  socket.on("webrtc:request_connect", ({ userId }) => {
    if(u.role!=="admin") return;
    const targetSid=socketByUser.get(userId);
    if(targetSid) {
      io.to(targetSid).emit("webrtc:connect_to_admin", { adminSocketId:socket.id, adminId:"ADMIN" });
    }
  });

  // Disconnect
  socket.on("disconnect", () => {
    onlineUsers.delete(socket.id);
    if(socketByUser.get(u.id)===socket.id) socketByUser.delete(u.id);
    const stillOnline=[...onlineUsers.values()].some(x=>x.id===u.id);
    if(!stillOnline) {
      speaking.delete(u.id);
      socket.broadcast.emit("user_offline",   { id:u.id });
      socket.broadcast.emit("user_speaking",  { userId:u.id, speaking:false });
      if(u.role==="admin") io.emit("admin_broadcasting", { broadcasting:false });
    }
    console.log(`[-] ${u.name} | online: ${onlineUsers.size}`);
  });
});

// Start
db.init().then(() => {
  const PORT = process.env.PORT || 8080;
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`\n╔══════════════════════════════════════╗`);
    console.log(`║  VoxSession v4 — WebRTC Edition      ║`);
    console.log(`║  Port: ${PORT}                          ║`);
    console.log(`╚══════════════════════════════════════╝\n`);
  });
}).catch(err => { console.error("[FATAL]", err.message); process.exit(1); });
 
module.exports = { app, server, io };
