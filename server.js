const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000
});

// Serve static files from public directory
app.use(express.static(path.join(__dirname, "public")));

// Basic middleware
app.use(express.json());
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
  next();
});

// Room state management
let movieRoom = {
  users: new Map(),
  currentTime: 0,
  isPlaying: false,
  lastUpdate: Date.now(),
  movieUrl: process.env.MOVIE_URL || ""
};

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    users: movieRoom.users.size,
    uptime: Math.floor(process.uptime()),
    memory: process.memoryUsage(),
    timestamp: new Date().toISOString()
  });
});

app.get('/api/room-info', (req, res) => {
  res.json({
    userCount: movieRoom.users.size,
    currentTime: movieRoom.currentTime,
    isPlaying: movieRoom.isPlaying,
    lastUpdate: movieRoom.lastUpdate
  });
});

// Socket.IO connection handling
io.on("connection", (socket) => {
  const userId = socket.id;
  const userInfo = {
    id: userId,
    connected: Date.now(),
    lastSeen: Date.now(),
    ip: socket.handshake.address
  };
  
  movieRoom.users.set(userId, userInfo);
  
  console.log(`✅ User connected: ${userId.substring(0, 6)} from ${userInfo.ip} (Total: ${movieRoom.users.size})`);
  
  // Send initial room state to new user
  socket.emit('roomState', {
    userCount: movieRoom.users.size,
    currentTime: movieRoom.currentTime,
    isPlaying: movieRoom.isPlaying,
    movieUrl: movieRoom.movieUrl
  });
  
  // Broadcast user count update to everyone
  io.emit('userCount', movieRoom.users.size);
  
  // Handle video control events
  socket.on("control", (data) => {
    try {
      const { type, time, timestamp } = data;
      
      console.log(`🎮 Control ${type.toUpperCase()}: ${time}s from ${userId.substring(0, 6)} at ${new Date().toLocaleTimeString()}`);
      
      // Update room state
      if (time !== undefined && !isNaN(time)) {
        movieRoom.currentTime = parseFloat(time);
      }
      
      if (type === 'play') {
        movieRoom.isPlaying = true;
      } else if (type === 'pause') {
        movieRoom.isPlaying = false;
      }
      
      movieRoom.lastUpdate = Date.now();
      
      // Update user activity
      if (movieRoom.users.has(userId)) {
        movieRoom.users.get(userId).lastSeen = Date.now();
      }
      
      // Broadcast to all other clients (not sender)
      socket.broadcast.emit("control", {
        type,
        time: movieRoom.currentTime,
        timestamp: Date.now(),
        from: userId.substring(0, 6)
      });
      
    } catch (error) {
      console.error(`❌ Control error from ${userId.substring(0, 6)}: ${error.message}`);
    }
  });
  
  // Handle sync requests
  socket.on("requestSync", () => {
    console.log(`🔄 Sync requested by ${userId.substring(0, 6)}`);
    socket.emit("control", {
      type: movieRoom.isPlaying ? 'play' : 'pause',
      time: movieRoom.currentTime,
      timestamp: Date.now(),
      sync: true
    });
  });
  
  // Handle chat messages
  socket.on("chatMessage", (message) => {
    if (message && typeof message === 'string' && message.trim().length > 0) {
      const chatData = {
        user: userId.substring(0, 6),
        message: message.trim().substring(0, 200), // Limit message length
        timestamp: Date.now()
      };
      
      console.log(`💬 Chat from ${chatData.user}: ${chatData.message}`);
      
      // Broadcast to everyone including sender
      io.emit("chatMessage", chatData);
    }
  });
  
  // Handle movie URL updates
  socket.on("updateMovieUrl", (url) => {
    if (url && typeof url === 'string') {
      movieRoom.movieUrl = url;
      console.log(`🎬 Movie URL updated by ${userId.substring(0, 6)}: ${url.substring(0, 50)}...`);
      
      // Broadcast new movie URL to all other users
      socket.broadcast.emit("movieUrlUpdate", url);
    }
  });
  
  // Handle disconnection
  socket.on("disconnect", (reason) => {
    movieRoom.users.delete(userId);
    console.log(`❌ User disconnected: ${userId.substring(0, 6)} (${reason}) (Total: ${movieRoom.users.size})`);
    
    // Broadcast updated user count
    io.emit('userCount', movieRoom.users.size);
  });
  
  // Handle connection errors
  socket.on("error", (error) => {
    console.error(`🔥 Socket error for ${userId.substring(0, 6)}:`, error.message);
  });
});

// Cleanup inactive users every 5 minutes
setInterval(() => {
  const now = Date.now();
  const fiveMinutesAgo = now - (5 * 60 * 1000);
  let cleanedCount = 0;
  
  for (const [userId, userInfo] of movieRoom.users) {
    if (userInfo.lastSeen < fiveMinutesAgo) {
      movieRoom.users.delete(userId);
      cleanedCount++;
    }
  }
  
  if (cleanedCount > 0) {
    console.log(`🧹 Cleaned up ${cleanedCount} inactive users`);
    io.emit('userCount', movieRoom.users.size);
  }
}, 5 * 60 * 1000);

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🎬 Movie Sync Server Started`);
  console.log(`🌐 Local: http://localhost:${PORT}`);
  console.log(`📁 Serving from: ${path.join(__dirname, 'public')}`);
  console.log(`⏰ Started at: ${new Date().toLocaleString()}`);
});

// Graceful shutdown handling
process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('🛑 SIGINT received, shutting down gracefully');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});
