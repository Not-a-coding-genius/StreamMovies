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

// Google Drive Proxy Route - WITH RANGE REQUEST SUPPORT FOR VIDEO SEEKING
app.get('/proxy/:fileId', (req, res) => {
  const fileId = req.params.fileId;
  
  const urls = [
    `https://drive.google.com/uc?export=download&id=${fileId}`,
    `https://drive.usercontent.google.com/download?id=${fileId}&export=download`,
    `https://docs.google.com/uc?export=download&id=${fileId}`,
    `https://drive.google.com/file/d/${fileId}/preview`
  ];
  
  console.log(`🔄 Proxying Google Drive file: ${fileId}`);
  
  // Extract Range header from client request for video seeking
  const range = req.headers.range;
  console.log(`📊 Range request: ${range || 'No range (full file)'}`);
  
  // Set CORS headers
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET');
  res.header('Access-Control-Allow-Headers', 'Range, Content-Range');
  res.header('Accept-Ranges', 'bytes');
  
  let urlIndex = 0;
  let responseHandled = false;
  
  // Set response timeout to 10 minutes for large files
  res.setTimeout(600000, () => {
    console.log(`⏱️ Response timeout (10min) for file: ${fileId}`);
    if (!responseHandled) {
      responseHandled = true;
      res.status(408).json({ error: 'Request timeout' });
    }
  });
  
  function tryNextUrl() {
    if (responseHandled) return;
    
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
    
    // Build headers - INCLUDE RANGE HEADER for video seeking
    const proxyHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      'Accept': 'video/*,*/*;q=0.9',
      'Accept-Encoding': 'identity',
      'Connection': 'keep-alive',
      'Cache-Control': 'no-cache'
    };
    
    // CRITICAL: Forward the Range header to Google Drive for seeking
    if (range) {
      proxyHeaders['Range'] = range;
      console.log(`🎯 Forwarding range: ${range}`);
    }
    
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: proxyHeaders,
      timeout: 60000
    };
    
    const protocol = urlObj.protocol === 'https:' ? https : http;
    
    const proxyReq = protocol.request(options, (proxyRes) => {
      if (responseHandled) return;
      
      console.log(`Proxy response: ${proxyRes.statusCode} for URL ${urlIndex + 1}`);
      
      // Handle both 200 (full content) and 206 (partial content) responses
      if (proxyRes.statusCode === 200 || proxyRes.statusCode === 206) {
        console.log(`✅ Proxy success for file: ${fileId} using URL ${urlIndex + 1} (${proxyRes.statusCode})`);
        
        if (!responseHandled) {
          responseHandled = true;
          
          // Build response headers
          const responseHeaders = {
            'Access-Control-Allow-Origin': '*',
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'public, max-age=86400'
          };
          
          // Copy important headers from Google Drive response
          if (proxyRes.headers['content-type']) {
            responseHeaders['Content-Type'] = proxyRes.headers['content-type'];
          }
          
          if (proxyRes.headers['content-length']) {
            responseHeaders['Content-Length'] = proxyRes.headers['content-length'];
            console.log(`📏 Content length: ${Math.round(proxyRes.headers['content-length'] / 1024 / 1024)}MB`);
          }
          
          // CRITICAL: Forward Content-Range header for video seeking
          if (proxyRes.headers['content-range']) {
            responseHeaders['Content-Range'] = proxyRes.headers['content-range'];
            console.log(`🎯 Content-Range: ${proxyRes.headers['content-range']}`);
          }
          
          // Use the same status code as Google Drive (200 or 206)
          res.writeHead(proxyRes.statusCode, responseHeaders);
          
          // Handle streaming with progress tracking
          let bytesStreamed = 0;
          const startTime = Date.now();
          
          proxyRes.on('data', (chunk) => {
            bytesStreamed += chunk.length;
            
            // Log progress every 10MB for full downloads only
            if (!range && bytesStreamed % (10 * 1024 * 1024) < chunk.length) {
              console.log(`📊 Streamed ${Math.round(bytesStreamed / 1024 / 1024)}MB for ${fileId}`);
            }
          });
          
          proxyRes.on('end', () => {
            const duration = (Date.now() - startTime) / 1000;
            if (range) {
              console.log(`✅ Range request completed: ${fileId} (${range}) in ${duration}s`);
            } else {
              console.log(`✅ Full streaming completed: ${fileId} (${Math.round(bytesStreamed / 1024 / 1024)}MB in ${duration}s)`);
            }
          });
          
          proxyRes.on('error', (err) => {
            console.error(`❌ Streaming error for ${fileId}:`, err.message);
            if (!res.headersSent) {
              res.status(500).end();
            }
          });
          
          // Pipe the response
          proxyRes.pipe(res);
        }
        
      } else if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400) {
        // Handle redirects
        const redirectUrl = proxyRes.headers.location;
        if (redirectUrl && !responseHandled) {
          console.log(`🔄 Redirecting to: ${redirectUrl}`);
          
          const redirectUrlObj = new URL(redirectUrl);
          
          // Build redirect headers - INCLUDE RANGE HEADER for seeking
          const redirectHeaders = {
            'User-Agent': proxyHeaders['User-Agent'],
            'Accept': proxyHeaders['Accept'],
            'Cache-Control': 'no-cache'
          };
          
          // CRITICAL: Forward the Range header to redirect URL for seeking
          if (range) {
            redirectHeaders['Range'] = range;
            console.log(`🎯 Forwarding range to redirect: ${range}`);
          }
          
          const redirectOptions = {
            hostname: redirectUrlObj.hostname,
            path: redirectUrlObj.pathname + redirectUrlObj.search,
            method: 'GET',
            headers: redirectHeaders,
            timeout: 60000
          };
          
          const redirectProtocol = redirectUrlObj.protocol === 'https:' ? https : http;
          
          const redirectReq = redirectProtocol.request(redirectOptions, (redirectRes) => {
            if (responseHandled) return;
            
            // Handle both 200 and 206 for redirects
            if (redirectRes.statusCode === 200 || redirectRes.statusCode === 206) {
              console.log(`✅ Redirect success for file: ${fileId} (${redirectRes.statusCode})`);
              
              if (!responseHandled) {
                responseHandled = true;
                
                const redirectResponseHeaders = {
                  'Access-Control-Allow-Origin': '*',
                  'Accept-Ranges': 'bytes',
                  'Cache-Control': 'public, max-age=86400'
                };
                
                // Copy headers from Google Drive redirect response
                if (redirectRes.headers['content-type']) {
                  redirectResponseHeaders['Content-Type'] = redirectRes.headers['content-type'];
                }
                
                if (redirectRes.headers['content-length']) {
                  redirectResponseHeaders['Content-Length'] = redirectRes.headers['content-length'];
                  console.log(`📏 Redirect content length: ${Math.round(redirectRes.headers['content-length'] / 1024 / 1024)}MB`);
                }
                
                // CRITICAL: Forward Content-Range header for video seeking
                if (redirectRes.headers['content-range']) {
                  redirectResponseHeaders['Content-Range'] = redirectRes.headers['content-range'];
                  console.log(`🎯 Redirect Content-Range: ${redirectRes.headers['content-range']}`);
                }
                
                // Use the same status code as Google Drive redirect (200 or 206)
                res.writeHead(redirectRes.statusCode, redirectResponseHeaders);
                
                // Handle redirect streaming with progress
                let redirectBytesStreamed = 0;
                const redirectStartTime = Date.now();
                
                redirectRes.on('data', (chunk) => {
                  redirectBytesStreamed += chunk.length;
                  
                  // Log progress for full downloads only
                  if (!range && redirectBytesStreamed % (10 * 1024 * 1024) < chunk.length) {
                    console.log(`📊 Redirect streamed ${Math.round(redirectBytesStreamed / 1024 / 1024)}MB for ${fileId}`);
                  }
                });
                
                redirectRes.on('end', () => {
                  const redirectDuration = (Date.now() - redirectStartTime) / 1000;
                  if (range) {
                    console.log(`✅ Redirect range completed: ${fileId} (${range}) in ${redirectDuration}s`);
                  } else {
                    console.log(`✅ Redirect full streaming completed: ${fileId} (${Math.round(redirectBytesStreamed / 1024 / 1024)}MB in ${redirectDuration}s)`);
                  }
                });
                
                redirectRes.on('error', (err) => {
                  console.error(`❌ Redirect streaming error for ${fileId}:`, err.message);
                });
                
                redirectRes.pipe(res);
              }
            } else {
              console.warn(`❌ Redirect failed with status ${redirectRes.statusCode}`);
              urlIndex++;
              setTimeout(tryNextUrl, 1000);
            }
          });
          
          redirectReq.on('error', (err) => {
            console.error(`❌ Redirect request error:`, err.message);
            urlIndex++;
            setTimeout(tryNextUrl, 1000);
          });
          
          redirectReq.on('timeout', () => {
            console.error(`⏱️ Redirect connection timeout`);
            redirectReq.destroy();
            urlIndex++;
            setTimeout(tryNextUrl, 1000);
          });
          
          redirectReq.end();
        } else {
          urlIndex++;
          setTimeout(tryNextUrl, 1000);
        }
      } else {
        console.warn(`❌ Proxy failed with status ${proxyRes.statusCode} for URL ${urlIndex + 1}`);
        urlIndex++;
        setTimeout(tryNextUrl, 1000);
      }
    });
    
    proxyReq.on('error', (err) => {
      console.error(`❌ Proxy error for URL ${urlIndex + 1}:`, err.message);
      if (!responseHandled) {
        urlIndex++;
        setTimeout(tryNextUrl, 1000);
      }
    });
    
    proxyReq.on('timeout', () => {
      console.error(`⏱️ Proxy connection timeout for URL ${urlIndex + 1}`);
      proxyReq.destroy();
      if (!responseHandled) {
        urlIndex++;
        setTimeout(tryNextUrl, 1000);
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
    status: 'Range-enabled proxy ready',
    fileId: fileId,
    proxyUrl: `/proxy/${fileId}`,
    timestamp: new Date().toISOString(),
    features: ['range-requests', 'video-seeking', 'large-file-streaming', 'progress-tracking'],
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
    features: ['range-requests', 'video-seeking', 'large-file-proxy', 'websockets', 'chat', 'progress-tracking']
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
  // Handle video control events - IMPROVED VERSION
  socket.on("control", (data) => {
    try {
      const { type, time, timestamp } = data;
      
      console.log(`🎮 Control ${type.toUpperCase()}: ${time}s from ${userId.substring(0, 6)} at ${new Date().toLocaleTimeString()}`);
      
      // Update room state based on control type
      if (time !== undefined && !isNaN(time)) {
        const newTime = parseFloat(time);
        
        // For seek commands, always update the room time
        if (type === 'seek') {
          movieRoom.currentTime = newTime;
          console.log(`🎯 Room time updated to: ${newTime}s (seek)`);
        }
        // For play/pause, only update if the time difference is reasonable
        else if (type === 'play' || type === 'pause') {
          const timeDiff = Math.abs(movieRoom.currentTime - newTime);
          
          if (timeDiff < 300) { // Less than 5 minutes difference
            movieRoom.currentTime = newTime;
            console.log(`🔄 Room time updated to: ${newTime}s (${type}, diff: ${timeDiff.toFixed(1)}s)`);
          } else {
            console.log(`⚠️ Large time difference (${timeDiff.toFixed(1)}s) - keeping room time at ${movieRoom.currentTime}s`);
          }
        }
        // For timesync, only update if difference is small
        else if (type === 'timesync') {
          const timeDiff = Math.abs(movieRoom.currentTime - newTime);
          
          if (timeDiff < 10) { // Less than 10 seconds difference
            movieRoom.currentTime = newTime;
          }
        }
      }
      
      // Update play state
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
        time: movieRoom.currentTime, // Send the room's current time
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

// Start server with enhanced configuration for video streaming
const PORT = process.env.PORT || 10000;

// Configure server timeouts for large file streaming and range requests
server.keepAliveTimeout = 600000; // 10 minutes
server.headersTimeout = 600000;   // 10 minutes
server.requestTimeout = 600000;   // 10 minutes

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🎬 Movie Sync Server Started`);
  console.log(`🌐 Host: 0.0.0.0:${PORT}`);
  console.log(`📁 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔧 Features: Range Requests, Video Seeking, Large File Streaming, WebSocket, Chat`);
  console.log(`⏰ Started at: ${new Date().toLocaleString()}`);
  console.log(`📊 Timeouts: 10 minutes for large file streaming and seeking`);
});

// Enhanced error handling
server.on('error', (error) => {
  console.error('🔥 Server error:', error);
  if (error.code === 'EADDRINUSE') {
    console.log(`❌ Port ${PORT} is already in use`);
  }
});

// Handle client errors
server.on('clientError', (err, socket) => {
  console.error('🔥 Client error:', err.message);
  socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
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

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  console.error('🔥 Uncaught Exception:', err);
  console.log('Server will continue running');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('🔥 Unhandled Rejection at:', promise, 'reason:', reason);
  console.log('Server will continue running');
});
