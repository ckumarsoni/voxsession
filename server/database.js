"use strict";
const path   = require("path");
const fs     = require("fs");
const bcrypt = require("bcryptjs");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const DB_FILE  = path.join(DATA_DIR, "voxsession.json");

let DATA = { users:[], sessions:[], joins:[], messages:[], adminRecordings:[] };

function init() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.mkdirSync(path.join(__dirname, "..", "public", "audio"), { recursive: true });
    fs.mkdirSync(path.join(__dirname, "..", "public", "audio", "admin"), { recursive: true });
    if (fs.existsSync(DB_FILE)) {
      const loaded = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
      DATA = { adminRecordings:[], ...loaded };
      console.log(`[DB] Loaded — ${DATA.users.length} users, ${DATA.messages.length} messages, ${DATA.adminRecordings.length} admin recordings`);
    } else {
      seedUsers();
      save();
      console.log("[DB] Created fresh database");
    }
    return Promise.resolve();
  } catch(e) {
    console.error("[DB] Init error:", e.message);
    seedUsers();
    return Promise.resolve();
  }
}

function save() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DB_FILE, JSON.stringify(DATA, null, 2));
  } catch(e) { console.error("[DB] Save error:", e.message); }
}

function seedUsers() {
  if (DATA.users.length === 0) {
    const seed = [
      { id:"USR001", name:"Aisha Mehta",  pw:"pass001", av:"AM", color:"blue"   },
      { id:"USR002", name:"Rohan Desai",  pw:"pass002", av:"RD", color:"orange" },
      { id:"USR003", name:"Priya Sharma", pw:"pass003", av:"PS", color:"green"  },
      { id:"USR004", name:"Karan Joshi",  pw:"pass004", av:"KJ", color:"purple" },
      { id:"USR005", name:"Neha Patil",   pw:"pass005", av:"NP", color:"orange" },
    ];
    DATA.users = seed.map(u => ({ id:u.id, name:u.name, password_hash:bcrypt.hashSync(u.pw,10), avatar:u.av, color:u.color, created_at:Date.now() }));
    console.log("[DB] Seeded 5 demo users");
  }
}

// Users
const getAllUsers    = () => DATA.users.map(u => ({ id:u.id, name:u.name, avatar:u.avatar, color:u.color, created_at:u.created_at }));
const getUserById   = id => DATA.users.find(u => u.id===id) || null;
const getUserCount  = ()  => DATA.users.length;
function createUser({ id, name, password_hash, avatar, color }) { DATA.users.push({ id, name, password_hash, avatar, color, created_at:Date.now() }); save(); }
function deleteUser(id) { DATA.users = DATA.users.filter(u=>u.id!==id); save(); }

// Sessions
const getAllSessions   = () => [...DATA.sessions].sort((a,b)=>b.started_at-a.started_at);
const getActiveSession = () => DATA.sessions.find(s=>!s.ended_at)||null;
const getSessionById   = id => DATA.sessions.find(s=>s.id===id)||null;
function createSession({ id, title }) { DATA.sessions.push({ id, title, started_at:Date.now(), ended_at:null }); save(); }
function endSession(id) { const s=DATA.sessions.find(s=>s.id===id); if(s){ s.ended_at=Date.now(); save(); } }
function joinSession(sid, uid) { if(!DATA.joins.find(j=>j.session_id===sid&&j.user_id===uid)){ DATA.joins.push({ session_id:sid, user_id:uid, joined_at:Date.now() }); save(); } }
const getSessionJoins = sid => DATA.joins.filter(j=>j.session_id===sid).map(j=>j.user_id);
const getUserSessions = uid => { const ids=new Set(DATA.messages.filter(m=>m.user_id===uid).map(m=>m.session_id)); return DATA.sessions.filter(s=>ids.has(s.id)).sort((a,b)=>b.started_at-a.started_at); };

// Messages
const getSessionMessages = sid => DATA.messages.filter(m=>m.session_id===sid).sort((a,b)=>a.recorded_at-b.recorded_at);
function getUserMessages(uid, date) {
  const myIds=new Set(DATA.messages.filter(m=>m.user_id===uid&&!m.is_admin_reply).map(m=>m.id));
  let msgs=DATA.messages.filter(m=>m.user_id===uid||(m.is_admin_reply&&myIds.has(m.reply_to_id)));
  if(date){ const s=new Date(date).setHours(0,0,0,0),e=new Date(date).setHours(23,59,59,999); msgs=msgs.filter(m=>m.recorded_at>=s&&m.recorded_at<=e); }
  return msgs.sort((a,b)=>a.recorded_at-b.recorded_at);
}
function getAllMessages(date) {
  let msgs=[...DATA.messages];
  if(date){ const s=new Date(date).setHours(0,0,0,0),e=new Date(date).setHours(23,59,59,999); msgs=msgs.filter(m=>m.recorded_at>=s&&m.recorded_at<=e); }
  return msgs.sort((a,b)=>a.recorded_at-b.recorded_at);
}
const getMessageById = id => DATA.messages.find(m=>m.id===id)||null;
function createMessage({ id,session_id,user_id,user_name,avatar,color,is_admin_reply,reply_to_id,audio_filename,duration,file_size }) {
  DATA.messages.push({ id,session_id,user_id,user_name,avatar,color,is_admin_reply:!!is_admin_reply,reply_to_id:reply_to_id||null,audio_filename,duration,file_size,recorded_at:Date.now() });
  save();
}
const getAllMessageDates  = () => [...new Set(DATA.messages.map(m=>new Date(m.recorded_at).toISOString().slice(0,10)))].sort().reverse();
const getUserMessageDates = uid => { const myIds=new Set(DATA.messages.filter(m=>m.user_id===uid).map(m=>m.id)); const msgs=DATA.messages.filter(m=>m.user_id===uid||(m.is_admin_reply&&myIds.has(m.reply_to_id))); return [...new Set(msgs.map(m=>new Date(m.recorded_at).toISOString().slice(0,10)))].sort().reverse(); };

// Admin Recordings
function createAdminRecording({ id, session_id, audio_filename, duration, file_size }) {
  DATA.adminRecordings.push({ id, session_id, audio_filename, duration, file_size, recorded_at:Date.now() });
  save();
}
const getSessionAdminRecordings = sid => DATA.adminRecordings.filter(r=>r.session_id===sid).sort((a,b)=>a.recorded_at-b.recorded_at);
const getAllAdminRecordings      = ()  => [...DATA.adminRecordings].sort((a,b)=>b.recorded_at-a.recorded_at);

const getStats = () => ({
  totalUsers:       DATA.users.length,
  totalSessions:    DATA.sessions.length,
  totalMessages:    DATA.messages.length,
  adminReplies:     DATA.messages.filter(m=>m.is_admin_reply).length,
  adminRecordings:  DATA.adminRecordings.length,
  totalStorage:     DATA.messages.reduce((s,m)=>s+(m.file_size||0),0) + DATA.adminRecordings.reduce((s,r)=>s+(r.file_size||0),0),
});

module.exports = {
  init, save,
  getAllUsers, getUserById, getUserCount, createUser, deleteUser,
  getAllSessions, getActiveSession, getSessionById, createSession, endSession,
  joinSession, getSessionJoins, getUserSessions,
  getSessionMessages, getUserMessages, getAllMessages, getMessageById, createMessage,
  getAllMessageDates, getUserMessageDates,
  createAdminRecording, getSessionAdminRecordings, getAllAdminRecordings,
  getStats,
};
