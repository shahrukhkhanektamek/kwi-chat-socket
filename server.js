const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

// Store user connections
const users = new Map();
// Store ticket rooms and their participants
const ticketRooms = new Map();

// ============================================
// Health Check Route (Test in Browser)
// ============================================
app.get('/', (req, res) => {
    res.json({
        status: 'ok',
        service: 'KWI Support Chat Socket Server',
        port: PORT,
        activeUsers: users.size,
        activeRooms: ticketRooms.size,
        time: new Date().toISOString()
    });
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
});

const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    transports: ['polling', 'websocket'],
    pingTimeout: 60000,
    pingInterval: 25000
});

io.on('connection', (socket) => {
    console.log('✅ User connected:', socket.id);

    // Get user info
    const userId = socket.handshake.auth.userId;
    const userType = socket.handshake.auth.userType;

    console.log(`👤 User: ${userType} | ID: ${userId}`);

    if (userId) {
        users.set(userId, { socketId: socket.id, userType, socket });
    }

    // ============================================
    // JOIN TICKET ROOM
    // ============================================
    socket.on('join-ticket', (data) => {
        const { ticketId } = data;
        
        if (!ticketId) {
            socket.emit('error', { message: 'Ticket ID required' });
            return;
        }
        
        // Leave previous room
        if (socket.currentRoom) {
            socket.leave(socket.currentRoom);
            // Remove from ticketRooms
            if (ticketRooms.has(socket.currentRoom.replace('ticket_', ''))) {
                const room = ticketRooms.get(socket.currentRoom.replace('ticket_', ''));
                if (room) {
                    const index = room.participants.indexOf(userId);
                    if (index !== -1) {
                        room.participants.splice(index, 1);
                    }
                }
            }
        }
        
        // Join new room
        const roomName = `ticket_${ticketId}`;
        socket.join(roomName);
        socket.currentRoom = roomName;
        
        // Track participants
        if (!ticketRooms.has(ticketId)) {
            ticketRooms.set(ticketId, { 
                participants: [],
                admin: null,
                user: null
            });
        }
        
        const room = ticketRooms.get(ticketId);
        if (userType === 'admin') {
            room.admin = userId;
        } else {
            room.user = userId;
        }
        if (!room.participants.includes(userId)) {
            room.participants.push(userId);
        }
        
        // ✅ Broadcast to room that someone joined
        io.to(roomName).emit('user-joined', {
            userId: userId,
            userType: userType,
            ticketId: ticketId
        });
        
        socket.emit('joined', { 
            ticketId, 
            success: true,
            room: roomName,
            participants: room.participants
        });
        
        console.log(`📌 ${userType} ${userId} joined ticket ${ticketId}`);
        console.log(`👥 Participants in ticket ${ticketId}:`, room.participants);
    });

    // ============================================
    // SEND MESSAGE - ✅ Broadcast to ALL in room
    // ============================================
    socket.on('send-message', (data) => {
        const { ticketId, supportId, message, attachment } = data;
        const roomId = ticketId || supportId;
        
        if (!roomId) {
            socket.emit('error', { message: 'Ticket ID required' });
            return;
        }
        
        const roomName = `ticket_${roomId}`;
        
        const messageData = {
            id: Date.now() + '_' + Math.random().toString(36).substr(2, 6),
            support_id: roomId,
            sender_id: userId,
            sender_type: userType,
            message: message || '',
            attachment: attachment || null,
            time: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
            created_at: new Date().toISOString()
        };

        // ✅ IMPORTANT: Broadcast to everyone in the room (including sender)
        io.to(roomName).emit('new-message', messageData);
        
        // ✅ Also send directly to the sender's socket for confirmation
        socket.emit('message-sent', {
            success: true,
            data: messageData
        });
        
        console.log(`💬 ${userType} ${userId} sent message to ticket ${roomId}`);
        console.log(`📝 Message: ${message || 'Attachment only'}`);
        console.log(`📡 Broadcast to room: ${roomName}`);
        
        // ✅ Log all participants in the room
        const room = io.sockets.adapter.rooms.get(roomName);
        if (room) {
            console.log(`👥 Room ${roomName} has ${room.size} clients:`, [...room]);
        } else {
            console.log(`⚠️ Room ${roomName} not found!`);
        }
    });

    // ============================================
    // TYPING INDICATOR
    // ============================================
    socket.on('typing', (data) => {
        const { ticketId, isTyping } = data;
        
        if (!ticketId) return;
        
        const roomName = `ticket_${ticketId}`;
        socket.to(roomName).emit('user-typing', {
            userId: userId,
            userType: userType,
            isTyping: isTyping
        });
    });

    // ============================================
    // STATUS UPDATE
    // ============================================
    socket.on('status-update', (data) => {
        const { ticketId, status } = data;
        
        if (!ticketId) {
            socket.emit('error', { message: 'Ticket ID required' });
            return;
        }
        
        const statusLabels = {
            'pending': 'Pending',
            'accepted': 'Active',
            'closed': 'Closed'
        };
        
        const statusData = {
            ticketId: ticketId,
            status: status,
            status_label: statusLabels[status] || status,
            updatedBy: userId,
            updatedByType: userType,
            time: new Date().toISOString()
        };
        
        // Broadcast to everyone in the room
        io.to(`ticket_${ticketId}`).emit('ticket-status-updated', statusData);
        
        console.log(`🔄 Ticket ${ticketId} status updated to ${status} by ${userType} ${userId}`);
    });

    // ============================================
    // NEW TICKET NOTIFICATION
    // ============================================
    socket.on('new-ticket-created', (data) => {
        console.log('🆕 New ticket created:', data);
        
        // Broadcast to all admins
        io.emit('new-ticket', {
            ticket_id: data.ticket_id,
            subject: data.subject,
            user_name: data.user_name,
            url: data.url,
            id: data.id
        });
    });

    // ============================================
    // GET ROOM INFO (Debugging)
    // ============================================
    socket.on('get-room-info', (data) => {
        const { ticketId } = data;
        const roomName = `ticket_${ticketId}`;
        const room = io.sockets.adapter.rooms.get(roomName);
        
        socket.emit('room-info', {
            ticketId: ticketId,
            roomName: roomName,
            clients: room ? [...room] : [],
            size: room ? room.size : 0,
            participants: ticketRooms.get(ticketId) || null
        });
    });

    // ============================================
    // DISCONNECT
    // ============================================
    socket.on('disconnect', () => {
        console.log('❌ User disconnected:', userId);
        if (userId) {
            users.delete(userId);
            
            // Remove from ticketRooms
            ticketRooms.forEach((room, ticketId) => {
                const index = room.participants.indexOf(userId);
                if (index !== -1) {
                    room.participants.splice(index, 1);
                }
                if (room.admin === userId) room.admin = null;
                if (room.user === userId) room.user = null;
            });
        }
    });
});

const PORT = process.env.PORT || 3003;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`===============================================`);
    console.log(`🚀 KWI Socket server running on http://0.0.0.0:${PORT}`);
    console.log(`🔍 Browser Health Check: http://72.62.194.69:${PORT}/`);
    console.log(`📡 Waiting for connections...`);
    console.log(`===============================================`);
});