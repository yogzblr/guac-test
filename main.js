// DOM elements
const connectionScreen = document.getElementById('connection-screen');
const displayScreen = document.getElementById('display-screen');

let currentClient = null; // Store the current Guacamole client
let currentKeyboard = null; // Store the keyboard handler
let pasteEventListener = null; // Store the paste event listener reference
const params = new URLSearchParams(window.location.search);
let token = params.get('token') || '';
if (!token) {
    document.body.innerHTML = '<h2>No valid token provided</h2>';
 }


    try {
        // Clear previous display if any
        const displayDiv = document.getElementById('display');
        while (displayDiv.firstChild) {
            displayDiv.removeChild(displayDiv.firstChild);
        }

      
        // Initialize Guacamole client
        initializeGuacamoleClient(token);
    } catch (error) {
        console.error("Failed to connect:", error);
        alert("Connection failed: " + error.message);

        // Switch back to connection screen on error
        displayScreen.style.display = 'none';
    }

// Function to initialize Guacamole client
function initializeGuacamoleClient(token) {
    // Switch to display screen before initializing to avoid UI jumping
    displayScreen.style.display = 'flex';

    // Update display title with connection info
    const displayTitle = document.getElementById('display-title');
 

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
        //	const tunnel = new Guacamole.WebSocketTunnel(`ws://${location.hostname}:9091/`);

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
        displayDiv.appendChild(client.getDisplay().getElement());

        // Set up error handler
        client.onerror = function (error) {
            console.error("Guacamole error:", error);
            let errorMessage = error.message || "Unknown error";

            // Enhanced error messages for common issues

            alert("Guacamole error: " + errorMessage);
        };

        // Set up clipboard handler
        client.onclipboard = (stream, mimetype) => {
            let data = '';
            const reader = new Guacamole.StringReader(stream);
            reader.ontext = text => data += text;
            reader.onend = () => {
                console.log("Clipboard data received:", data);
                // Update the hidden textarea and trigger copy
                const textarea = document.getElementById('clipboard-textarea');
                if (textarea) {
                    textarea.value = data;
                    textarea.select();
                    try {
                        const successful = document.execCommand('copy');
                        const msg = successful ? 'successful' : 'unsuccessful';
                        console.log('Copying text command was ' + msg);
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

        // Set up paste event listener
        pasteEventListener = (event) => {
            const text = event.clipboardData.getData('text/plain');
            if (text && currentClient) {
                event.preventDefault(); // Prevent default paste behavior in browser
                // Send clipboard data to the remote session
                const stream = currentClient.createClipboardStream('text/plain');
                const writer = new Guacamole.StringWriter(stream);
                writer.sendText(text);
                writer.sendEnd();
                console.log("Sent clipboard data to remote:", text);
            }
        };
        window.addEventListener('paste', pasteEventListener);

        // Connect to the remote desktop
        // Construct connection string, adding audio only if RDP
        	
        client.connect();

        console.log("Guacamole client initialized and connected");
    } catch (error) {
        // Clean up any partially created resources
        cleanupGuacamole();

        // Show error and return to connection screen
        console.error("Error initializing Guacamole:", error);
        alert("Error initializing Guacamole: " + error.message);
        displayScreen.style.display = 'none';
        connectionScreen.style.display = 'flex';
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

 }


// Handle page unloads to clean up any active sessions
window.addEventListener('beforeunload', () => {
    cleanupGuacamole();
});
