class WarpTalk {
  constructor(
    protocol = window.location.protocol,
    host = window.location.host
  ) {
    this.joinedRooms = {};
    this.registeredNickname = false;
    // Private properties
    this._protocol = protocol;
    this._host = host;
    this._pingInterval = null;
    this._reconnectAttempts = 0;
    this._httpProtocol = protocol === "ws" ? "http://" : "https://";
    this._baseURL = this._httpProtocol + this._host;
    if (this._baseURL[this._baseURL.length - 1] === "/")
      this._baseURL = this._baseURL.slice(0, -1);
  }

  get _reconnectDelay() {
    return 1000 * Math.pow(1.5, this._reconnectAttempts++);
  }

  connect(callback, nickname = "") {
    let host = `${this._protocol}://${this._host}`;
    console.log(`Connecting to ${host}...`);
    this.socket = new WebSocket(host);
    if (this._pingInterval) clearInterval(this._pingInterval);
    this._pingInterval = setInterval(() => {
      this.socket.send(JSON.stringify({ type: "ping" }));
    }, 5000);
    this.socket.addEventListener("open", () => {
      this._reconnectAttempts = 0;
      // Checking if we session with a registered nickname
      this._getRegisteredNickname((info) => {
        if (info.loggedIn) {
          this.registeredNickname = true;
          this.nickname = info.nickname;
        } else {
          this.nickname = nickname;
        }
        this.getRooms((rooms) => {
          this.availableRooms = rooms;
          this.socket.send(
            JSON.stringify({ type: "nickname", value: this.nickname })
          );
          let registeredNick = false;
          this.socket.addEventListener("message", (msg) => {
            let data = JSON.parse(msg.data);
            if (data.type !== "confirm" || data.value !== "nickname") return;
            if (registeredNick) return;
            console.log(`Nickname ${this.nickname} registered on server`);
            registeredNick = true;
            if (callback) callback();
          });
        });
      });
    });
    this.socket.addEventListener("message", (msg) => {
      try {
        let data = JSON.parse(msg.data);
        if (data.type == "error") {
          console.warn("Got error from server:", data);
          if (data.errorMessage === "Nickname taken") {
            alert(
              "Nickname is taken or you are trying to connect anonymously multiple times from the same browser session."
            );
            this.reload();
          }
          return;
        }
        if (data.type === "join") {
          if (this.joinedRooms[data.room]) {
            let room = this.joinedRooms[data.room];
            let alreadyThere = room.clients
              ? room.clients.map((c) => c.nickname).indexOf(data.nickname) > -1
              : false;
            room.clients = data.list;
            room.handleClientJoin(data.nickname, alreadyThere);
          }
        }
        if (data.type === "leave") {
          if (this.joinedRooms[data.room]) {
            let room = this.joinedRooms[data.room];
            room.clients = data.list;
            room.handleClientLeave(data.nickname);
          }
        }
        if (data.type === "message") {
          if (!this.joinedRooms[data.room]) return;
          this.joinedRooms[data.room].handleMessage(data);
        }
        if (data.type === "pong") {
          // just for keeping the connection alive.
        }
      } catch (e) {
        console.log(e);
      }
    });
    this.socket.addEventListener("close", () => {
      console.log("Connection server lost, trying to reconnect");
      for (let room in this.joinedRooms) {
        this.joinedRooms[room].handleDisconnect();
      }
      clearInterval(this._pingInterval);
      this._reconnectAttempts++;
      setTimeout(() => {
        this.connect(() => {
          setTimeout(() => {
            for (let room in this.joinedRooms) {
              this.joinedRooms[room].socket = this.socket;
              this.joinedRooms[room].rejoin();
            }
          }, 500);
        });
      }, this._reconnectDelay);
    });
  }

  reload() {
    window.location.reload();
  }

  join(roomName) {
    if (this.joinedRooms[roomName]) return this.joinedRooms[roomName];
    if (!this.availableRooms.map((r) => r.name).includes(roomName)) {
      throw Error("No such room");
      return;
    }
    let room = new Room(
      this.availableRooms.filter((r) => r.name === roomName)[0],
      this.socket
    );
    this.joinedRooms[roomName] = room;
    this.socket.send(JSON.stringify({ type: "join", room: roomName }));
    return room;
  }

  leave(roomName) {
    if (!this.joinedRooms[roomName]) return;
    delete this.joinedRooms[roomName];
    this.socket.send(JSON.stringify({ type: "leave", room: roomName }));
  }

  logout() {
    fetch(this._baseURL + "/logout", {
      mode: "cors",
      cache: "no-cache",
      credentials: "include",
    })
      .then(() => {
        this.reload();
      })
      .catch((error) => {
        throw error;
      });
  }

  login(nickname, password) {
    fetch(this._baseURL + "/login", {
      method: "POST",
      mode: "cors",
      cache: "no-cache",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ nickname, password }),
    })
      .then((res) => {
        this.reload();
      })
      .catch((error) => {
        throw error;
      });
  }

  getRooms(callback) {
    fetch(this._baseURL + "/room", {
      mode: "cors",
      cache: "no-cache",
      credentials: "include",
    })
      .then((response) => {
        return response.json();
      })
      .then((rooms) => {
        callback(rooms);
      });
  }

  isLoggedIn(callback) {
    this._getRegisteredNickname((nick) => {
      callback(nick.loggedIn);
    });
  }

  _getRegisteredNickname(callback) {
    fetch(this._baseURL + "/nickname", {
      mode: "cors",
      cache: "no-cache",
      credentials: "include",
    })
      .then((response) => {
        return response.json();
      })
      .then((data) => {
        callback(data);
      });
  }
}

class Room {
  constructor(roomData, socket) {
    this.name = roomData.name;
    this.description = roomData.description;
    this.socket = socket;
    this.clients = [];
    this.listeners = [];
    this.joinListeners = [];
    this.leaveListeners = [];
    this.disconnectListeners = [];
  }

  handleMessage(message) {
    this.listeners.forEach((listener) => listener(this, message));
  }

  handleClientJoin(nickname, alreadyThere) {
    if (!alreadyThere) {
      this.clients.push({ nickname });
    }
    this.joinListeners.forEach((listener) =>
      listener(this, nickname, alreadyThere)
    );
  }

  handleClientLeave(nickname) {
    this.clients = this.clients.filter(
      (client) => client.nickname !== nickname
    );
    this.leaveListeners.forEach((listener) => listener(this, nickname));
  }

  handleDisconnect() {
    this.disconnectListeners.forEach((listener) => listener(this));
  }

  onMessage(listener) {
    this.listeners.push(listener);
  }

  onJoin(listener) {
    this.joinListeners.push(listener);
  }

  onLeave(listener) {
    this.leaveListeners.push(listener);
  }

  onDisconnect(listener) {
    this.disconnectListeners.push(listener);
  }

  send(message) {
    this.socket.send(
      JSON.stringify({ type: "message", room: this.name, message: message })
    );
  }

  rejoin() {
    this.socket.send(JSON.stringify({ type: "join", room: this.name }));
  }
}

if (typeof exports !== "undefined") {
  exports.WarpTalk = WarpTalk;
} else {
  window.WarpTalk = WarpTalk;
}

// Configuring WarpTalk to use a specific server
let wt = new WarpTalk("wss", "warp.cs.au.dk/talk/");

console.log("Connecting to the WarpTalk server ...");

// Checking if user is logged in with a registered nickname
wt.isLoggedIn(function (isLoggedIn) {
  if (isLoggedIn) {
    // If isLoggedIn is true, we can call connect that we also give a function to call when the connection has been established
    wt.connect(connected);
  } else {
    // If not, we prompt the user for a temporary unregistered nickname
    let nickname = prompt("What's your (unregistered) nickname?");
    wt.connect(connected, nickname);

    // Show nickname on the sidebar
    document.querySelector("#nickname").innerHTML = nickname;
  }
});

// This function is called when the connection to the server is established (we give it as argument to connect above).
function connected() {
  console.log("Connection established.");

  // We can now list the rooms available on the server
  console.log("The server has the following rooms:");
  const roomsList = document.querySelector("#rooms-list");
  wt.availableRooms.forEach((r) => {
    // Render the rooms menu in the sidebar
    var room = document.createElement("li");
    room.innerHTML = r.name;
    room.id = `${r.name}`;
    roomsList.append(room);
    console.log(`- ${r.name}: ${r.description}`);

    room.addEventListener("click", () => {
      const room = document.querySelector(`#${r.name}`);
      showRoom(room.innerHTML);
    });
  });

  function showRoom(roomName) {
    const joined = wt.join(roomName);
    console.log("Joined room:", roomName);
    console.log(wt.joinedRooms);

    const roomContainer = document.querySelector(".room-container");
    roomContainer.id = `${roomName}`;

    const receivedContainer = document.querySelector("#received-space");
    const sendContainer = document.querySelector("#send-space");

    receivedContainer.innerHTML = "";
    sendContainer.innerHTML = "";
    roomContainer.innerHTML = "";

    // Create the headerDiv
    const headerContainer = document.createElement("div");
    headerContainer.id = "header-container";

    const header = document.createElement("h3");
    header.innerHTML = `#${roomName}`;
    headerContainer.append(header);

    roomContainer.append(headerContainer);

    // Create the clients list
    const clientsSidebar = document.querySelector(".connected-clients");
    clientsSidebar.innerHTML = "";

    const clientsHeader = document.createElement("h2");
    clientsHeader.innerHTML = "JOINED";
    clientsSidebar.append(clientsHeader);

    const clientsList = document.createElement("ul");
    clientsList.className = "clients-list";
    clientsSidebar.append(clientsList);

    // Ensure there are not any other previous listeners
    if (joined.listeners.length > 0) {
      joined.listeners = [];
    }

    // Create the receivedMessages
    joined.onMessage((room, msg) => {
      console.log(`${room.name} - ${msg.sender}: ${msg.message}`);

      if (room.name === roomContainer.id) {
        const nickname = document.querySelector("#nickname").innerHTML;

        // Create an outer messageContainer
        const outerContainer = document.createElement("div");

        // Create the receivedMessagesDiv
        const receivedMessagesContainer = document.createElement("div");
        if (msg.sender === nickname) {
          receivedMessagesContainer.className =
            "receivedMessage-container mine";
          outerContainer.className = "outer-div right";
        } else {
          receivedMessagesContainer.className = "receivedMessage-container";
          outerContainer.className = "outer-div";
        }

        // Create innerDiv
        const innerDiv = document.createElement("div");
        innerDiv.className = "inner-div";

        const receivedMessageSender = document.createElement("p");
        receivedMessageSender.className = "receivedMessageSender";
        receivedMessageSender.innerHTML = `${msg.sender}`;
        innerDiv.append(receivedMessageSender);

        const receivedMessage = document.createElement("p");
        receivedMessage.className = "receivedMessage";
        receivedMessage.innerHTML = msg.message;
        innerDiv.append(receivedMessage);

        receivedMessagesContainer.append(innerDiv);
        outerContainer.append(receivedMessagesContainer);

        // Create the timestampDiv
        const timestampContainer = document.createElement("div");
        timestampContainer.className = "timestamp-container";

        let timestamp = new Date().toLocaleString();

        const receivedTimestamp = document.createElement("p");
        receivedTimestamp.innerHTML = timestamp;
        receivedTimestamp.className = "receivedTimestamp";
        timestampContainer.append(receivedTimestamp);
        receivedMessagesContainer.append(timestampContainer);
        outerContainer.append(receivedMessagesContainer);

        receivedContainer.append(outerContainer);

        receivedContainer.scrollTop = receivedContainer.scrollHeight;
      }
    });

    // Create the onJoin notifications
    joined.onJoin((room, nickname) => {
      console.log(`${nickname} joined ${room.name}`);

      const notificationContainer = document.createElement("div");
      notificationContainer.className = "notification-container";

      const notification = document.createElement("p");
      notification.innerHTML = `${nickname} has joined #${room.name}`;
      notification.className = "notification join";
      notificationContainer.append(notification);

      receivedContainer.append(notification);

      if (!joined.clients.includes({ nickname })) {
        const clientItem = document.createElement("li");
        clientItem.innerHTML = nickname;
        clientsList.append(clientItem);
      }
    });

    roomContainer.append(receivedContainer);

    // Create the onLeave notifications
    joined.onLeave((room, nickname) => {
      console.log(`${nickname} left ${room.name}`);

      const notificationContainer = document.createElement("div");
      notificationContainer.className = "notification-container";

      const notification = document.createElement("p");
      notification.innerHTML = `${nickname} has left #${room.name}`;
      notification.className = "notification left";
      notificationContainer.append(notification);

      receivedContainer.append(notification);

      console.log(joined.clients);

      const clientItems = Array.from(clientsList.children);
      const clientItem = clientItems.find(
        (item) => item.innerHTML === nickname
      );
      if (clientItem) {
        clientsList.removeChild(clientItem);
      }
    });

    roomContainer.append(receivedContainer);

    // Create the sendMessageDiv
    const sendMessageInput = document.createElement("input");
    sendMessageInput.placeholder = "Send a message...";
    sendMessageInput.id = "sendMessage-input";
    sendContainer.append(sendMessageInput);

    sendMessageInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        const message = sendMessageInput.value;
        if (message) {
          joined.send(message);
          sendMessageInput.value = "";
        }
      }
    });

    roomContainer.append(sendContainer);
  }
}
