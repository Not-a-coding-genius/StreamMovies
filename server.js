const express = require("express");
const http = require("http");
const https = require("https");
const { Server } = require("socket.io");
const path = require("path");
const { URL } = require("url");

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

// Google Drive Proxy Route to Bypass CORS (FIXED VERSION)
app.get('/proxy/:fileId', (req, res) => {
  const fileId = req.params.fileId;
  
  // Try multiple Google Drive URLs
  const urls = [
    `https://drive.google.com/uc?export=download&id=${fileId}`,
    `https://drive.usercontent.google.com/download?id=${fileId}&export=download`,
    `https://docs.google.com/uc?export=download&id=${fileId}`,
    `https://drive.google.com/file/d/${fileId}/preview`
  ];
  
  console.log(`🔄 Proxying Google Drive file: ${fileId}`);
  
  // Set CORS headers
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET');
  res.header('Access-Control-Allow-Headers', 'Range, Content-Range');
  res.header('Accept-Ranges', 'bytes');
  
  let urlIndex = 0;
  let responseHandled = false; // Flag to prevent multiple responses
  
  function tryNextUrl() {
    if (responseHandled) return; // Prevent multiple responses
    
    if (urlIndex >= urls.length) {
      console.error(`❌ All proxy attempts failed for file: ${fileId}`);
      if (!responseHandled) {
        responseHandled = true;
        return res.status(404).json({ 
          error: 'All proxy attempts failed',
          fileId: fileId,
          attempts: urls.length
        });
      }
      return;
    }
    
    const currentUrl = urls[urlIndex];
    console.log(`Trying proxy URL ${urlIndex + 1}/${urls.length}: ${currentUrl}`);
    
    const urlObj = new URL(currentUrl);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'video/*,*/*;q=0.9',
        'Accept-Encoding': 'identity',
        'Connection': 'keep-alive'
      },
      timeout: 15000 // Increased timeout
    };
    
    const protocol = urlObj.protocol === 'https:' ? https : http;
    
    const proxyReq = protocol.request(options, (proxyRes) => {
      if (responseHandled) return; // Prevent multiple responses
      
      console.log(`Proxy response: ${proxyRes.statusCode} for URL ${urlIndex + 1}`);
      
      if (proxyRes.statusCode === 200) {
        // Success! Forward the response
        console.log(`✅ Proxy success for file: ${fileId} using URL ${urlIndex + 1}`);
        
        if (!responseHandled) {
          responseHandled = true;
          
          res.writeHead(200, {
            'Content-Type': proxyRes.headers['content-type'] || 'video/mp4',
            'Content-Length': proxyRes.headers['content-length'],
            'Access-Control-Allow-Origin': '*',
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'public, max-age=3600'
          });
          
          proxyRes.pipe(res);
          
          // Handle pipe errors
          proxyRes.on('error', (err) => {
            console.error('Pipe error:', err.message);
          });
        }
        
      } else if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400) {
        // Handle redirects
        const redirectUrl = proxyRes.headers.location;
        if (redirectUrl && !responseHandled) {
          console.log(`🔄 Redirecting to: ${redirectUrl}`);
          
          // Follow the redirect with a new request
          const redirectUrlObj = new URL(redirectUrl);
          const redirectOptions = {
            hostname: redirectUrlObj.hostname,
            path: redirectUrlObj.pathname + redirectUrlObj.search,
            method: 'GET',
            headers: {
              'User-Agent': options.headers['User-Agent'],
              'Accept': options.headers['Accept']
            },
            timeout: 15000
          };
          
          const redirectProtocol = redirectUrlObj.protocol === 'https:' ? https : http;
          
          const redirectReq = redirectProtocol.request(redirectOptions, (redirectRes) => {
            if (responseHandled) return;
            
            if (redirectRes.statusCode === 200) {
              console.log(`✅ Redirect success for file: ${fileId}`);
              
              if (!responseHandled) {
                responseHandled = true;
                
                res.writeHead(200, {
                  'Content-Type': redirectRes.headers['content-type'] || 'video/mp4',
                  'Content-Length': redirectRes.headers['content-length'],
                  'Access-Control-Allow-Origin': '*',
                  'Accept-Ranges': 'bytes'
                });
                
                redirectRes.pipe(res);
                
                redirectRes.on('error', (err) => {
                  console.error('Redirect pipe error:', err.message);
                });
              }
            } else {
              console.warn(`❌ Redirect failed with status ${redirectRes.statusCode}`);
              urlIndex++;
              setTimeout(tryNextUrl, 500); // Small delay before trying next URL
            }
          });
          
          redirectReq.on('error', (err) => {
            console.error(`❌ Redirect request error:`, err.message);
            urlIndex++;
            setTimeout(tryNextUrl, 500);
          });
          
          redirectReq.on('timeout', () => {
            console.error(`⏱️ Redirect timeout`);
            redirectReq.destroy();
            urlIndex++;
            setTimeout(tryNextUrl, 500);
          });
          
          redirectReq.end();
        } else {
          urlIndex++;
          setTimeout(tryNextUrl, 500);
        }
      } else {
        // Error, try next URL
        console.warn(`❌ Proxy failed with status ${proxyRes.statusCode} for URL ${urlIndex + 1}`);
        urlIndex++;
        setTimeout(tryNextUrl, 500);
      }
    });
    
    proxyReq.on('error', (err) => {
      console.error(`❌ Proxy error for URL ${urlIndex + 1}:`, err.message);
      if (!responseHandled) {
        urlIndex++;
        setTimeout(tryNextUrl, 500);
      }
    });
    
    proxyReq.on('timeout', () => {
      console.error(`⏱️ Proxy timeout for URL ${urlIndex + 1}`);
      proxyReq.destroy();
      if (!responseHandled) {
        urlIndex++;
        setTimeout(tryNextUrl, 500);
      }
    });
    
    proxyReq.end();
  }
  
  tryNextUrl();
});

// Proxy health check
app.get('/proxy-test/:fileId', (req, res) => {
  const fileId = req.params.fileId;
  res.json({
    status: 'Proxy endpoint ready',
    fileId: fileId,
    proxyUrl: `/proxy/${fileId}`,
    timestamp: new Date().toISOString(),
    testUrls: [
      `https://drive.google.com/uc?export=download&id=${fileId}`,
      `https://drive.usercontent.google.com/download?id=${fileId}&export=download`
    ]
  });
});

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
    timestamp: new Date().toISOString(),
    features: ['proxy', 'websockets', 'chat']
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
const PORT = process.env.PORT || 10000;

// Configure server timeouts for video streaming
server.keepAliveTimeout = 120000; // 120 seconds
server.headersTimeout = 120000;   // 120 seconds

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🎬 Movie Sync Server Started`);
  console.log(`🌐 Host: 0.0.0.0:${PORT}`);
  console.log(`📁 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔧 Features: WebSocket, Chat, Google Drive Proxy`);
  console.log(`⏰ Started at: ${new Date().toLocaleString()}`);
});

// Add error handling
server.on('error', (error) => {
  console.error('🔥 Server error:', error);
  if (error.code === 'EADDRINUSE') {
    console.log(`❌ Port ${PORT} is already in use`);
  }
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
