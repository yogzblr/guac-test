let currentClient = null; // Store the current Guacamole client
let currentKeyboard = null; // Store the keyboard handler
let pasteEventListener = null; // Store the paste event listener reference
let clipboardUpdateListener = null; // Store clipboard update listener

// DOM elements (will be initialized when DOM is ready)
let connectionScreen = null;
let displayScreen = null;
let clipboardInput = null;
let sendClipboardBtn = null;
let getClipboardBtn = null;
let clearClipboardBtn = null;
let connectionStatus = null;
let connectionInfo = null;

// Wait for DOM to be ready
document.addEventListener('DOMContentLoaded', () => {
    // Initialize DOM elements
    connectionScreen = document.getElementById('connection-screen');
    displayScreen = document.getElementById('display-screen');
    clipboardInput = document.getElementById('clipboard-input');
    sendClipboardBtn = document.getElementById('send-clipboard-btn');
    getClipboardBtn = document.getElementById('get-clipboard-btn');
    clearClipboardBtn = document.getElementById('clear-clipboard-btn');
    connectionStatus = document.getElementById('connection-status');
    connectionInfo = document.getElementById('connection-info');

    const params = new URLSearchParams(window.location.search);
    let token = params.get('token') || '';
    
    // Check for token - show error message if not provided
    if (!token) {
        if (document.body) {
            document.body.innerHTML = `
                <div style="
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    height: 100vh;
                    background: #1a1a1a;
                    color: #e0e0e0;
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
                ">
                    <div style="text-align: center; padding: 40px;">
                        <h2 style="color: #ff4444; margin-bottom: 20px; font-size: 24px;">No valid token provided</h2>
                        <p style="color: #aaa; font-size: 14px;">Please provide a valid token in the URL query parameter.</p>
                        <p style="color: #888; font-size: 12px; margin-top: 10px;">Example: ?token=your-token-here</p>
                    </div>
                </div>
            `;
        }
        return;
    }

    try {
        // Clear previous display if any
        const displayDiv = document.getElementById('display');
        if (displayDiv) {
            while (displayDiv.firstChild) {
                displayDiv.removeChild(displayDiv.firstChild);
            }
        }

        // Initialize Guacamole client
        initializeGuacamoleClient(token);
    } catch (error) {
        console.error("Failed to connect:", error);
        alert("Connection failed: " + error.message);

        // Switch back to connection screen on error
        if (displayScreen) {
            displayScreen.style.display = 'none';
        }
        if (connectionScreen) {
            connectionScreen.style.display = 'flex';
        }
    }
});

// Function to initialize Guacamole client
function initializeGuacamoleClient(token) {
    // Switch to display screen before initializing to avoid UI jumping
    if (displayScreen) {
        displayScreen.style.display = 'flex';
    }
    if (connectionScreen) {
        connectionScreen.style.display = 'none';
    }

    try {
        // Create WebSocket tunnel
	const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    	// create base ws origin (host includes port if needed)
    	const base = `${proto}://${location.host}/ws`; // NO trailing slash
    	const urlObj = new URL(base);
    	urlObj.searchParams.set('token', token); // automatically encodes

    	const wsUrl = urlObj.toString(); // e.g. ws://host:8080/ws?token=...

  	// (optional) defensive cleanup if some upstream added junk
    	const cleanedWsUrl = wsUrl.replace(/\?undefined$/, '');

    	console.log('Using WebSocket URL:', cleanedWsUrl);
    	const tunnel = new Guacamole.WebSocketTunnel(cleanedWsUrl);

        // Set up onuuid event handler to log connection ID
        tunnel.onuuid = function (uuid) {
            console.log("Connection UUID received:", uuid);
            console.log("This UUID can be used to join this session from another client");
        };

        // Create client
        const client = new Guacamole.Client(tunnel);
        currentClient = client;

        // Add client display to the page
        const displayDiv = document.getElementById("display");
        if (!displayDiv) {
            throw new Error("Display element not found");
        }
        displayDiv.appendChild(client.getDisplay().getElement());

        // Set up error handler
        client.onerror = function (error) {
            console.error("Guacamole error:", error);
            let errorMessage = error.message || "Unknown error";

            // Enhanced error messages for common issues

            alert("Guacamole error: " + errorMessage);
        };

        // Set up clipboard handler - receives clipboard data from remote session
        client.onclipboard = (stream, mimetype) => {
            let data = '';
            const reader = new Guacamole.StringReader(stream);
            reader.ontext = text => data += text;
            reader.onend = () => {
                console.log("Clipboard data received from remote:", data);
                
                // Update the visible clipboard input area
                if (clipboardInput) {
                    clipboardInput.value = data;
                }
                
                // Also copy to system clipboard
                const textarea = document.getElementById('clipboard-textarea');
                if (textarea) {
                    textarea.value = data;
                    textarea.select();
                    try {
                        const successful = document.execCommand('copy');
                        const msg = successful ? 'successful' : 'unsuccessful';
                        console.log('Copying text to system clipboard was ' + msg);
                        
                        // Show visual feedback
                        if (clipboardInput) {
                            clipboardInput.style.borderColor = '#4a9eff';
                            setTimeout(() => {
                                clipboardInput.style.borderColor = '#555';
                            }, 500);
                        }
                    } catch (err) {
                        console.error('Failed to copy text: ', err);
                    }
                    // Deselect the text to avoid visual artifacts
                    window.getSelection().removeAllRanges();
                }
            };
        };

        // Set up file download handler
        client.onfile = (stream, mimetype, filename) => {
            stream.sendAck("Ready", Guacamole.Status.Code.SUCCESS);

            const reader = new Guacamole.BlobReader(stream, mimetype);

            reader.onprogress = (length) => {
                console.log(`Downloaded ${length} bytes of ${filename}`);
            };

            reader.onend = () => {
                // Automatically create a link and download the file
                const file = reader.getBlob();
                const url = URL.createObjectURL(file);
                const a = document.createElement("a");
                a.href = url;
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                setTimeout(() => {
                    document.body.removeChild(a);
                    URL.revokeObjectURL(url);
                    console.log(`File download complete: ${filename}`);
                }, 100);
            };
        };

        // Set up mouse
        const mouse = new Guacamole.Mouse(client.getDisplay().getElement());
        mouse.onEach(['mousedown', 'mouseup', 'mousemove', 'mousewheel'],
            e => client.sendMouseState(e.state));

        // Set up keyboard
        const keyboard = new Guacamole.Keyboard(window);
        keyboard.onkeydown = keysym => client.sendKeyEvent(1, keysym);
        keyboard.onkeyup = keysym => client.sendKeyEvent(0, keysym);
        currentKeyboard = keyboard;

        // Set up paste event listener for system clipboard paste
        pasteEventListener = (event) => {
            const text = event.clipboardData.getData('text/plain');
            if (text && currentClient) {
                event.preventDefault(); // Prevent default paste behavior in browser
                sendClipboardToRemote(text);
            }
        };
        window.addEventListener('paste', pasteEventListener);

        // Set up clipboard input change listener to update UI
        clipboardUpdateListener = () => {
            // Auto-update when user types in clipboard input
            // This allows manual editing before sending
        };
        
        // Function to send clipboard data to remote session
        function sendClipboardToRemote(text) {
            if (!currentClient || !text) {
                console.warn('Cannot send clipboard: no client or empty text');
                return;
            }
            
            try {
                const stream = currentClient.createClipboardStream('text/plain');
                const writer = new Guacamole.StringWriter(stream);
                writer.sendText(text);
                writer.sendEnd();
                console.log("Sent clipboard data to remote:", text.substring(0, 100) + (text.length > 100 ? '...' : ''));
                
                // Visual feedback
                if (clipboardInput) {
                    clipboardInput.style.borderColor = '#4a9eff';
                    setTimeout(() => {
                        clipboardInput.style.borderColor = '#555';
                    }, 500);
                }
            } catch (error) {
                console.error('Failed to send clipboard to remote:', error);
                alert('Failed to send clipboard data: ' + error.message);
            }
        }

        // Set up clipboard UI button handlers
        if (sendClipboardBtn) {
            sendClipboardBtn.addEventListener('click', () => {
                const text = clipboardInput ? clipboardInput.value : '';
                if (text.trim()) {
                    sendClipboardToRemote(text);
                } else {
                    alert('Clipboard is empty. Please enter or paste some text first.');
                }
            });
        }

        if (getClipboardBtn) {
            getClipboardBtn.addEventListener('click', () => {
                // Request clipboard from remote by reading system clipboard
                // Note: Browser security prevents reading clipboard without user interaction
                // So we'll try to read from system clipboard if available
                if (navigator.clipboard && navigator.clipboard.readText) {
                    navigator.clipboard.readText().then(text => {
                        if (clipboardInput) {
                            clipboardInput.value = text;
                        }
                        console.log('Retrieved clipboard from system:', text.substring(0, 100));
                    }).catch(err => {
                        console.error('Failed to read clipboard:', err);
                        // Fallback: try to get from remote session's last clipboard update
                        // This is handled by the onclipboard event
                    });
                } else {
                    // Fallback: clipboard data should already be in clipboardInput from onclipboard events
                    console.log('Clipboard reading not available, using last received clipboard data');
                }
            });
        }

        if (clearClipboardBtn) {
            clearClipboardBtn.addEventListener('click', () => {
                if (clipboardInput) {
                    clipboardInput.value = '';
                }
                const textarea = document.getElementById('clipboard-textarea');
                if (textarea) {
                    textarea.value = '';
                }
            });
        }

        // Allow Ctrl+V / Cmd+V to paste into clipboard input and auto-send
        if (clipboardInput) {
            clipboardInput.addEventListener('paste', (e) => {
                // Let the paste happen first, then send after a short delay
                setTimeout(() => {
                    const text = clipboardInput.value;
                    if (text && currentClient) {
                        sendClipboardToRemote(text);
                    }
                }, 100);
            });
        }

        // Update connection status
        if (connectionStatus) {
            connectionStatus.classList.remove('disconnected');
        }

        // Connect to the remote desktop
        client.connect();

        // Handle connection state changes
        client.onstatechange = (state) => {
            console.log("Connection state changed:", state);
            if (connectionStatus) {
                if (state === Guacamole.Client.CONNECTED) {
                    connectionStatus.classList.remove('disconnected');
                    if (connectionInfo) {
                        connectionInfo.textContent = 'Connected';
                    }
                } else if (state === Guacamole.Client.DISCONNECTED) {
                    connectionStatus.classList.add('disconnected');
                    if (connectionInfo) {
                        connectionInfo.textContent = 'Disconnected';
                    }
                } else if (state === Guacamole.Client.CONNECTING) {
                    if (connectionInfo) {
                        connectionInfo.textContent = 'Connecting...';
                    }
                }
            }
        };

        console.log("Guacamole client initialized and connected");
    } catch (error) {
        // Clean up any partially created resources
        cleanupGuacamole();

        // Show error and return to connection screen
        console.error("Error initializing Guacamole:", error);
        alert("Error initializing Guacamole: " + error.message);
        if (displayScreen) {
            displayScreen.style.display = 'none';
        }
        if (connectionScreen) {
            connectionScreen.style.display = 'flex';
        }
    }
}

// Function to properly clean up all Guacamole resources
function cleanupGuacamole() {
    if (currentClient) {
        // Disconnect the client
        try {
            currentClient.disconnect();
        } catch (e) {
            console.error("Error disconnecting client:", e);
        }
        currentClient = null;
    }

    // Properly detach keyboard handler
    if (currentKeyboard) {
        try {
            // Remove existing handlers
            currentKeyboard.onkeydown = null;
            currentKeyboard.onkeyup = null;

            // Reset the keyboard state completely
            currentKeyboard.reset();
        } catch (e) {
            console.error("Error cleaning up keyboard:", e);
        }
        currentKeyboard = null;
    }

    // Remove paste event listener if it exists
    if (pasteEventListener) {
        window.removeEventListener('paste', pasteEventListener);
        pasteEventListener = null;
    }

    // Remove clipboard update listener if it exists
    if (clipboardUpdateListener && clipboardInput) {
        clipboardInput.removeEventListener('input', clipboardUpdateListener);
        clipboardUpdateListener = null;
    }

    // Update connection status
    if (connectionStatus) {
        connectionStatus.classList.add('disconnected');
    }
    if (connectionInfo) {
        connectionInfo.textContent = 'Disconnected';
    }
}


// Handle page unloads to clean up any active sessions
window.addEventListener('beforeunload', () => {
    cleanupGuacamole();
});
