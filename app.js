/*
 * Lógica del cliente para el juego El Impostor.
 *
 * Este archivo administra las interacciones de la interfaz de usuario y
 * realiza solicitudes HTTP al servidor para crear salas, iniciar
 * partidas, enviar pistas, votar y recuperar resultados.  Dado que no
 * dependemos de React u otras librerías externas en este entorno,
 * utilizamos DOM API vanila y eventos para construir la experiencia.
 */

(function () {
  // Detectar el entorno para establecer la URL base de la API.
  //
  // - Si la página se sirve desde localhost (por ejemplo durante
  //   desarrollo local), usa el backend local en http://localhost:3000.
  // - En cualquier otro caso (incluido GitHub Pages), usa la URL del
  //   backend desplegado en Render.  Esto permite que la aplicación
  //   funcione correctamente cuando se despliega en dominios como
  //   *.github.io o en file://.
  const API_BASE = window.location.hostname.includes('localhost')
    ? 'http://localhost:3000'
    : 'https://el-impostor-back-end.onrender.com';
  // Elementos de la interfaz
  const screens = {
    create: document.getElementById('createRoomScreen'),
    lobby: document.getElementById('lobbyScreen'),
    clues: document.getElementById('clueScreen'),
    vote: document.getElementById('voteScreen'),
    results: document.getElementById('resultsScreen'),
  };
  const namesInput = document.getElementById('namesInput');
  const createRoomBtn = document.getElementById('createRoomBtn');

  const joinRoomIdInput = document.getElementById('joinRoomId');
  const joinNameInput = document.getElementById('joinName');
  const joinRoomBtn = document.getElementById('joinRoomBtn');
  const roomIdDisplay = document.getElementById('roomIdDisplay');
  const playersList = document.getElementById('playersList');
  // Eliminamos el selector de nombres; cada jugador ya envía su nombre al unirse
  // y recibe un playerId automáticamente.  El host es el primer nombre de la lista.
  const startGameBtn = document.getElementById('startGameBtn');
  const forceStartBtn = document.getElementById('forceStartBtn');

  const playerInfoDiv = document.getElementById('playerInfo');
  const clueInput = document.getElementById('clueInput');
  const sendClueBtn = document.getElementById('sendClueBtn');
  const cluesList = document.getElementById('cluesList');
  const goToVoteBtn = document.getElementById('goToVoteBtn');
  const forceVoteBtn = document.getElementById('forceVoteBtn');

  const voteOptions = document.getElementById('voteOptions');
  const submitVoteBtn = document.getElementById('submitVoteBtn');
  const showResultsBtn = document.getElementById('showResultsBtn');
  const forceResultsBtn = document.getElementById('forceResultsBtn');
  const votesList = document.getElementById('votesList');

  const resultsContent = document.getElementById('resultsContent');
  const nextActionBtn = document.getElementById('nextActionBtn');
  const forceNextBtn = document.getElementById('forceNextBtn');

  // Estado local
  let roomId = null;
  let playerId = null;
  let state = null;
  let players = [];
  let clues = [];
  let votes = [];
  let pollInterval = null;
  let sentClue = false;
  let voted = false;

  // Track previous state to reset confirmation flags when transitioning
  let prevState = null;

  let creatorId = null;
  // What action is currently being awaited in results (nextClue or nextRound)
  let awaitingAction = null;
  // Confirmation counts and required counts returned by the server
  let confirmationsCount = { start: 0, votePhase: 0, nextClue: 0, nextRound: 0, showResults: 0 };
  let requiredConfirmationsCount = { start: 0, votePhase: 0, nextClue: 0, nextRound: 0, showResults: 0 };
  // Flags to remember if the local player has already confirmed a communal action
  let startConfirmed = false;
  let votePhaseConfirmed = false;
  let nextClueConfirmed = false;
  let nextRoundConfirmed = false;
  let showResultsConfirmed = false;

  // Remember the last error message received from the server to avoid
  // showing the same alert multiple times during polling.  When a new
  // error appears, it will be alerted to the user.
  let lastErrorMsg = null;

  /**
   * Muestra una pantalla y oculta las demás.  Cada pantalla corresponde a
   * una fase del juego (creación, lobby, pistas, votación, resultados).
   *
   * @param {string} screen Nombre de la pantalla a mostrar
   */
  function showScreen(screen) {
    Object.values(screens).forEach((el) => {
      el.hidden = true;
    });
    switch (screen) {
      case 'create':
        screens.create.hidden = false;
        break;
      case 'lobby':
        screens.lobby.hidden = false;
        break;
      case 'clues':
        screens.clues.hidden = false;
        break;
      case 'vote':
        screens.vote.hidden = false;
        break;
      case 'results':
        screens.results.hidden = false;
        break;
    }
  }

  /**
   * Envía una petición HTTP con método y cuerpo opcional.  Devuelve una
   * promesa que se resuelve con el JSON de la respuesta.  Si el servidor
   * responde con un código de error se rechaza la promesa.
   *
   * @param {string} url URL relativa (sin dominio)
   * @param {string} method Método HTTP
   * @param {Object|null} body Objeto a serializar como JSON
   */
  async function apiRequest(url, method = 'GET', body = null) {
    const options = { method, headers: {} };
    if (body) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    // Prefijar con API_BASE cuando sea necesario
    const fullUrl = API_BASE + url;
    const resp = await fetch(fullUrl, options);
    // Si la respuesta no es exitosa (códigos 4xx o 5xx), intentar
    // extraer un mensaje de error.  Muchos endpoints devuelven un
    // JSON con la propiedad `error`; en otros casos se devuelve
    // texto plano.  Analizamos el tipo de contenido para decidir.
    if (!resp.ok) {
      const contentType = resp.headers.get('Content-Type') || '';
      let errMsg;
      try {
        if (contentType.includes('application/json')) {
          const errData = await resp.json();
          errMsg = errData.error || JSON.stringify(errData);
        } else {
          errMsg = await resp.text();
        }
      } catch (e) {
        errMsg = 'Error del servidor';
      }
      throw new Error(errMsg || 'Error del servidor');
    }
    const contentType = resp.headers.get('Content-Type') || '';
    if (contentType.includes('application/json')) {
      return resp.json();
    }
    return resp.text();
  }

  /**
   * Crea una sala con los nombres introducidos por el usuario.  Se
   * invoca al hacer clic en el botón «Crear sala».  Validamos que
   * existan al menos tres participantes, de lo contrario se lanza una
   * alerta.
   */
  async function createRoom() {
    const raw = namesInput.value;
    const list = raw
      .split(/\n|,/)
      .map((n) => n.trim())
      .filter((n) => n.length > 0);
    if (list.length < 3) {
      alert('Debes ingresar al menos tres nombres para empezar.');
      return;
    }
    try {
      const data = await apiRequest('/api/create-room', 'POST', { players: list });
      roomId = data.roomId;
      players = data.players;
      state = data.state;
      creatorId = data.creatorId;
      awaitingAction = null;
      sentClue = false;
      voted = false;
      startConfirmed = false;
      votePhaseConfirmed = false;
      nextClueConfirmed = false;
      nextRoundConfirmed = false;
      // Al crear la sala asignamos automáticamente el playerId al primer nombre de la lista
      if (players && players.length > 0) {
        playerId = players[0].id;
      }
      // Mostrar lobby
      roomIdDisplay.textContent = roomId;
      updatePlayersUI();
      // La lista de selección ya no es necesaria
      showScreen('lobby');
      startPolling();
    } catch (err) {
      console.error(err);
      alert('No se pudo crear la sala.');
    }
  }

  /**
   * Permite a un participante unirse a una sala existente.  Se
   * requieren el identificador de la sala y el nombre del jugador.
   * Tras la unión se asigna playerId automáticamente y se pasa al
   * lobby para esperar el inicio del juego.
   */
  async function joinRoom() {
    const id = joinRoomIdInput.value.trim();
    const name = joinNameInput.value.trim();
    if (!id || !name) {
      alert('Debes introducir el ID de la sala y tu nombre.');
      return;
    }
    try {
      const data = await apiRequest(`/api/room/${id}/join`, 'POST', { name });
      roomId = id;
      playerId = data.player.id;
      players = data.players;
      state = data.state;
      creatorId = data.creatorId;
      awaitingAction = null;
      sentClue = false;
      voted = false;
      startConfirmed = false;
      votePhaseConfirmed = false;
      nextClueConfirmed = false;
      nextRoundConfirmed = false;
      roomIdDisplay.textContent = roomId;
      updatePlayersUI();
      // Ya no hay lista de selección; cada jugador recibe su playerId directamente
      showScreen('lobby');
      startPolling();
    } catch (err) {
      console.error(err);
      alert('No se pudo unir a la sala. Verifica el ID y que la partida no haya comenzado.');
    }
  }

  /**
   * Actualiza la lista de jugadores en la pantalla de lobby.  Simplemente
   * recorre el array de players y crea elementos <li>.
   */
  function updatePlayersUI() {
    playersList.innerHTML = '';
    players.forEach((p) => {
      const li = document.createElement('li');
      li.textContent = p.name + (p.alive ? '' : ' (eliminado)');
      playersList.appendChild(li);
    });
  }

  /**
   * Crea botones de selección para que cada usuario pueda indicar quién
   * es.  Al pulsar en un nombre se guarda el id del jugador en
   * playerId y se resalta la selección.
   */
  function updateSelectPlayerUI() {
    selectPlayerList.innerHTML = '';
    players.forEach((p) => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.textContent = p.name;
      btn.onclick = () => {
        playerId = p.id;
        // Marcar selección visualmente desactivando otros botones
        Array.from(selectPlayerList.querySelectorAll('button')).forEach(
          (b) => {
            b.disabled = false;
          },
        );
        btn.disabled = true;
      };
      li.appendChild(btn);
      selectPlayerList.appendChild(li);
    });
  }

  /**
   * Inicia el juego haciendo una petición al servidor.  Solo se puede
   * invocar desde la pantalla de lobby.  Actualiza el estado local a
   * continuación.
   */
  async function startGame() {
    if (!roomId) return;
    try {
      const data = await apiRequest(`/api/room/${roomId}/start`, 'POST');
      state = data.state;
      // Los roles y asignaciones se devuelven solo desde el servidor,
      // pero no los necesitamos aquí porque cada jugador consulta la
      // información de su propia sala periódicamente.
    } catch (err) {
      console.error(err);
      alert('No se pudo iniciar el juego. Quizá ya esté iniciado.');
    }
  }

  /**
   * Envía una pista escrita por el jugador.  Se valida que el campo no
   * esté vacío y que el jugador se haya identificado (playerId).
   */
  async function sendClue() {
    if (!clueInput.value.trim()) {
      alert('La pista no puede estar vacía.');
      return;
    }
    if (!playerId) {
      alert('Debes unirte a la sala con tu nombre.');
      return;
    }
    try {
      await apiRequest(`/api/room/${roomId}/clue`, 'POST', {
        playerId,
        clue: clueInput.value.trim(),
      });
      clueInput.value = '';
      sentClue = true;
      sendClueBtn.disabled = true;
    } catch (err) {
      console.error(err);
      alert('No se pudo enviar la pista.');
    }
  }

  /**
   * Solicita al servidor pasar a la fase de votación.  Cualquier
   * participante puede activar esta acción una vez que todos hayan
   * escrito sus pistas.
   */
  async function goToVotePhase() {
    try {
      await apiRequest(`/api/room/${roomId}/vote-phase`, 'POST');
    } catch (err) {
      console.error(err);
      alert('No se pudo pasar a la fase de votación.');
    }
  }

  /**
   * Envía el voto del jugador.  Valida que se haya seleccionado una
   * opción y que el usuario no haya votado ya.
   */
  async function submitVote() {
    if (voted) return;
    const selected = voteOptions.querySelector('input[name="voteFor"]:checked');
    if (!selected) {
      alert('Selecciona a quién crees que es el impostor.');
      return;
    }
    try {
      await apiRequest(`/api/room/${roomId}/vote`, 'POST', {
        voterId: playerId,
        voteForId: selected.value,
      });
      voted = true;
      submitVoteBtn.disabled = true;
    } catch (err) {
      console.error(err);
      alert('No se pudo enviar el voto.');
    }
  }

  /**
   * Pide al servidor calcular y devolver los resultados.  Suele
   * invocarse una vez que todos votaron.  El servidor retorna quién
   * ha sido acusado y quién era realmente el impostor.
   */
  async function showResults() {
    try {
      const data = await apiRequest(`/api/room/${roomId}/results`, 'POST');
      // El servidor actualiza room.state internamente.  Tomamos el nuevo
      // estado del payload si se proporcionara.  Polling se encargará de
      // reflejarlo en el cliente.
      renderResults(data);
      showScreen('results');
      // After showing results, poll immediately to get awaitingAction and update counters
      await pollRoom();
    } catch (err) {
      console.error(err);
      alert('No se pudieron obtener los resultados.');
    }
  }

  /**
   * Envía una confirmación para una acción comunitaria al servidor.  Si
   * la acción alcanza el número requerido de confirmaciones será
   * ejecutada automáticamente.  Se actualizan las banderas locales
   * para evitar que el jugador confirme varias veces.  En caso de
   * error se muestra una alerta.
   *
   * @param {string} action Uno de 'start', 'votePhase', 'nextClue', 'nextRound'
   */
  async function sendConfirmation(action) {
    if (!roomId || !playerId) return;
    try {
      const data = await apiRequest(`/api/room/${roomId}/confirm`, 'POST', {
        playerId,
        action,
      });
      // Marcar como confirmado localmente
      switch (action) {
        case 'start':
          startConfirmed = true;
          break;
        case 'votePhase':
          votePhaseConfirmed = true;
          break;
        case 'nextClue':
          nextClueConfirmed = true;
          break;
        case 'nextRound':
          nextRoundConfirmed = true;
          break;
        case 'showResults':
          showResultsConfirmed = true;
          break;
      }
      // After a confirmation, poll immediately to update state
      await pollRoom();
    } catch (err) {
      console.error(err);
      // Mostrar el mensaje de error devuelto por el servidor si existe
      alert(err && err.message ? err.message : 'No se pudo confirmar la acción.');
    }
  }

  /**
   * Fuerza la ejecución de una acción comunitaria.  Solo disponible
   * para el creador de la sala.  Envia una solicitud al servidor
   * para ejecutar inmediatamente la acción sin esperar más
   * confirmaciones.
   *
   * @param {string} action Uno de 'start', 'votePhase', 'nextClue', 'nextRound'
   */
  async function forceAction(action) {
    if (!roomId || !playerId) return;
    try {
      await apiRequest(`/api/room/${roomId}/force`, 'POST', {
        playerId,
        action,
      });
      // Reset local confirmation flags for that action, since the
      // server will transition state immediately
      switch (action) {
        case 'start':
          startConfirmed = false;
          break;
        case 'votePhase':
          votePhaseConfirmed = false;
          break;
        case 'nextClue':
          nextClueConfirmed = false;
          break;
        case 'nextRound':
          nextRoundConfirmed = false;
          break;
      }
      await pollRoom();
    } catch (err) {
      console.error(err);
      alert(err && err.message ? err.message : 'No se pudo forzar la acción.');
    }
  }

  /**
   * Genera el contenido HTML de la pantalla de resultados.  Indica
   * quién fue acusado, quién era el impostor y si los jugadores
   * acertaron o no.  También muestra la cantidad de votos por cada
   * participante.
   *
   * @param {Object} data Objeto devuelto por el servidor en /results
   */
  function renderResults(data) {
    resultsContent.innerHTML = '';
    // data.message describe el resultado (descubierto, no descubierto, impostor gana)
    const messageP = document.createElement('p');
    messageP.textContent = data.message;
    messageP.style.fontWeight = 'bold';
    resultsContent.appendChild(messageP);
    // Mostrar lista de pistas enviadas en esta ronda
    if (clues && clues.length > 0) {
      const cluesTitle = document.createElement('h3');
      cluesTitle.textContent = 'Pistas enviadas:';
      resultsContent.appendChild(cluesTitle);
      const cluesListUl = document.createElement('ul');
      clues.forEach((c) => {
        const li = document.createElement('li');
        const author = players.find((p) => p.id === c.playerId);
        const name = author ? author.name : 'Desconocido';
        li.textContent = `${name}: ${c.clue}`;
        cluesListUl.appendChild(li);
      });
      resultsContent.appendChild(cluesListUl);
    }
    // Calcular el recuento de votos por id
    const votesCount = {};
    (data.votes || []).forEach((v) => {
      votesCount[v.voteForId] = (votesCount[v.voteForId] || 0) + 1;
    });
    // Mostrar recuento de votos para cada participante actual o eliminado
    const list = document.createElement('ul');
    const displayedIds = new Set([
      ...Object.keys(votesCount),
      ...players.map((p) => p.id),
    ]);
    displayedIds.forEach((pid) => {
      const li = document.createElement('li');
      const player = players.find((p) => p.id === pid);
      const name = player ? player.name : 'Jugador eliminado';
      const count = votesCount[pid] || 0;
      li.textContent = `${name}: ${count} voto${count !== 1 ? 's' : ''}`;
      list.appendChild(li);
    });
    const votesTitle = document.createElement('h3');
    votesTitle.textContent = 'Recuento de votos:';
    resultsContent.appendChild(votesTitle);
    resultsContent.appendChild(list);
    // Indicar si el juego continúa o ha terminado
    if (data.gameOver) {
      const endMsg = document.createElement('p');
      if (data.impostorWon) {
        endMsg.textContent = 'El impostor gana la partida.';
      } else {
        endMsg.textContent = 'Los jugadores han descubierto al impostor.';
      }
      resultsContent.appendChild(endMsg);
      // Si el servidor revela el nombre del jugador (soccerPlayerName),
      // mostrarlo en los resultados.  Esto sólo ocurre cuando la ronda
      // termina definitivamente.
      if (data.soccerPlayerName) {
        const playerReveal = document.createElement('p');
        playerReveal.textContent = `El jugador era ${data.soccerPlayerName}!`;
        playerReveal.style.fontStyle = 'italic';
        resultsContent.appendChild(playerReveal);
      }
    }
  }

  /**
   * Reinicia variables y vuelve a la pantalla de lobby para una nueva
   * ronda.  Mantiene la misma sala y lista de jugadores.
   */
  function newRound() {
    // Reset del estado local salvo roomId y players
    clues = [];
    votes = [];
    sentClue = false;
    voted = false;
    // Volver a estado lobby y permitir iniciar de nuevo
    showScreen('lobby');
  }

  /**
   * Consulta periódicamente el estado de la sala para actualizar la
   * interfaz en función de la fase del juego y los datos actuales
   * (pistas, votos, etc.).  Usa un intervalo de un segundo para
   * mantener sincronización sin WebSockets.
   */
  async function pollRoom() {
    if (!roomId) return;
    try {
      const data = await apiRequest(`/api/room/${roomId}`, 'GET');
      // Actualizar estado local
      state = data.state;
      players = data.players;
      clues = data.clues;
      votes = data.votes;
      creatorId = data.creatorId;
      awaitingAction = data.awaiting;
      confirmationsCount = data.confirmationsCount || confirmationsCount;
      requiredConfirmationsCount = data.requiredConfirmations || requiredConfirmationsCount;
      // Verificar si el servidor ha enviado un mensaje de error global (por ejemplo,
      // empate en la votación o votos incompletos).  Si hay un nuevo
      // mensaje, mostrarlo como alerta y recordar que ya fue mostrado.
      if (data.errorMessage && data.errorMessage !== lastErrorMsg) {
        lastErrorMsg = data.errorMessage;
        alert(data.errorMessage);
        // Después de un error global, permitir que el jugador vuelva a confirmar
        // la acción de resultados.
        showResultsConfirmed = false;
        // Si el error indica empate, reiniciar la marca de voto para que
        // el jugador pueda votar de nuevo (se han borrado los votos en el servidor).
        if (data.errorMessage.toLowerCase().includes('empatada')) {
          voted = false;
          // Rehabilitar el botón de votar si el jugador sigue vivo
          const current = players.find(p => p.id === playerId);
          if (current && current.alive) {
            submitVoteBtn.disabled = false;
          }
        }
      }
      // Actualizar UI según el estado
      // Determinar si el jugador es el anfitrión
      const isHost = playerId && creatorId && playerId === creatorId;
      // Encontrar datos del jugador actual para saber si está vivo
      const currentPlayerObj = players.find(p => p.id === playerId);
      const currentAlive = currentPlayerObj ? currentPlayerObj.alive : true;
      // LOBBY: mostrar start button con conteo
      if (state === 'lobby') {
        if (screens.lobby.hidden) {
          // Al entrar en lobby, reset flags de confirmaciones
          startConfirmed = false;
          votePhaseConfirmed = false;
          nextClueConfirmed = false;
          nextRoundConfirmed = false;
          showScreen('lobby');
        }
        // Actualizar lista de jugadores
        updatePlayersUI();
        // Mostrar contador en botón de inicio
        const curr = confirmationsCount.start || 0;
        const req = requiredConfirmationsCount.start || players.length;
        startGameBtn.textContent = `Iniciar juego (${curr}/${req})`;
        // Habilitar botón solo si el jugador aún no confirmó y se ha seleccionado
        startGameBtn.disabled = !playerId || startConfirmed;
        // Mostrar u ocultar el botón de forzar según si es anfitrión
        forceStartBtn.style.display = isHost ? 'inline-block' : 'none';
        forceStartBtn.disabled = false;
      }
      // CLUES: preparar pantalla de pistas si corresponde
      if (state === 'clues' && screens.clues.hidden) {
        prepareClueScreen();
        showScreen('clues');
      }
      if (state === 'clues') {
        // Actualizar lista de pistas
        renderClues();
        // Actualizar botón pasar a votación con conteo
        const curr = confirmationsCount.votePhase || 0;
        const req = requiredConfirmationsCount.votePhase || players.filter(p => p.alive).length;
        goToVoteBtn.textContent = `Pasar a votación (${curr}/${req})`;
        // Deshabilitar si ya confirmó o no es jugador vivo
        goToVoteBtn.disabled = votePhaseConfirmed || !playerId || !currentAlive;
        // Mostrar botón forzar sólo para anfitrión
        forceVoteBtn.style.display = isHost ? 'inline-block' : 'none';
        forceVoteBtn.disabled = false;
      }
      // VOTING: preparar pantalla de votación si corresponde
      if (state === 'voting' && screens.vote.hidden) {
        prepareVoteScreen();
        showScreen('vote');
      }
      if (state === 'voting') {
        renderVotes();
        // Actualizar botón "Ver resultados" con conteo de confirmaciones
        const currRes = confirmationsCount.showResults || 0;
        const reqRes = requiredConfirmationsCount.showResults || players.filter(p => p.alive).length;
        showResultsBtn.textContent = `Ver resultados (${currRes}/${reqRes})`;
        // Deshabilitar si ya confirmó o está eliminado
        const current = players.find(p => p.id === playerId);
        const alive = current ? current.alive : true;
        showResultsBtn.disabled = showResultsConfirmed || !alive;
        // Mostrar u ocultar botón de forzar resultados
        const isHost = playerId && creatorId && playerId === creatorId;
        forceResultsBtn.style.display = isHost ? 'inline-block' : 'none';
        forceResultsBtn.disabled = false;
      }
      // Ocultar fuerza de resultados en otros estados
      if (state !== 'voting') {
        forceResultsBtn.style.display = 'none';
      }
      // RESULTS: si el juego está en resultados y la pantalla no se ha mostrado
      if (state === 'results' && screens.results.hidden) {
        // El servidor almacena los datos de resultados en data.resultsData.  Si
        // existe, generamos la interfaz de resultados automáticamente.
        if (data.resultsData) {
          renderResults(data.resultsData);
        }
        showScreen('results');
      }
      // Actualizar botones en pantalla de resultados
      if (!screens.results.hidden) {
        // Ajustar etiquetas y disponibilidad en función de awaitingAction
        if (!awaitingAction) {
          // No hay acción pendiente, ocultar botones
          nextActionBtn.style.display = 'none';
          forceNextBtn.style.display = 'none';
        } else {
          nextActionBtn.style.display = 'inline-block';
          forceNextBtn.style.display = isHost ? 'inline-block' : 'none';
          if (awaitingAction === 'nextClue') {
            const curr = confirmationsCount.nextClue || 0;
            const req = requiredConfirmationsCount.nextClue || players.filter(p => p.alive).length;
            nextActionBtn.textContent = `Siguiente pista (${curr}/${req})`;
            nextActionBtn.disabled = nextClueConfirmed || !currentAlive;
          } else if (awaitingAction === 'nextRound') {
            const curr = confirmationsCount.nextRound || 0;
            const req = requiredConfirmationsCount.nextRound || players.length;
            nextActionBtn.textContent = `Siguiente ronda (${curr}/${req})`;
            // Eliminados también pueden confirmar para nueva ronda
            nextActionBtn.disabled = nextRoundConfirmed || !playerId;
          }
        }
      }

      // Reset confirmation flags on state transitions
      if (prevState !== state) {
        if (state === 'clues') {
          // Starting a clues round: reset clues and confirmations for vote phase
          sentClue = false;
          votePhaseConfirmed = false;
          nextClueConfirmed = false;
          showResultsConfirmed = false;
        }
        if (state === 'voting') {
          voted = false;
          // Reset showResults confirmation when entering voting
          showResultsConfirmed = false;
        }
        if (state === 'lobby') {
          startConfirmed = false;
          votePhaseConfirmed = false;
          nextClueConfirmed = false;
          nextRoundConfirmed = false;
          showResultsConfirmed = false;
        }
        if (state === 'results') {
          // When entering results, reset flags for next actions
          votePhaseConfirmed = false;
          // nextClueConfirmed and nextRoundConfirmed remain until used
          // reset showResults flag when leaving voting
          showResultsConfirmed = false;
        }
        prevState = state;
      }
    } catch (err) {
      console.error(err);
    }
  }

  /**
   * Prepara la pantalla de pistas mostrando al usuario la información
   * relevante (nombre del jugador de fútbol asignado o mensaje de
   * impostor).  También reinicia el control de envíos de pistas.
   */
  function prepareClueScreen() {
    sentClue = false;
    // Disable clue sending for eliminated players or if already sent
    sendClueBtn.disabled = false;
    clueInput.value = '';
    // Encontrar al jugador actual
    const current = players.find((p) => p.id === playerId);
    let message;
    if (!current) {
      message = 'No se ha seleccionado un jugador.';
    } else if (!current.alive) {
      message = 'Has sido eliminado. Observa la partida.';
      sendClueBtn.disabled = true;
    } else if (current.assignedPlayer) {
      // Mostrar únicamente el nombre del jugador asignado; el club no se
      // incluye para mantener el secreto hasta el final de la ronda.
      message = `Tu jugador es ${current.assignedPlayer.name}.`;
    } else {
      message = '¡Eres el impostor! No sabes quién es el jugador.';
    }
    playerInfoDiv.textContent = message;
    renderClues();
  }

  /**
   * Genera la lista de pistas en la interfaz.  Cada pista muestra
   * simplemente el texto escrito; las pistas no están asociadas a
   * nombres para evitar revelar la identidad de quien la escribió.
   */
  function renderClues() {
    cluesList.innerHTML = '';
    clues.forEach((c) => {
      const li = document.createElement('li');
      const author = players.find((p) => p.id === c.playerId);
      const name = author ? author.name : 'Desconocido';
      li.textContent = `${name}: ${c.clue}`;
      cluesList.appendChild(li);
    });
  }

  /**
   * Prepara la pantalla de votación, construyendo los radio buttons
   * correspondientes a cada participante.  Excluye al propio jugador si
   * este prefiere no votarse a sí mismo.
   */
  function prepareVoteScreen() {
    voted = false;
    // Disable voting for eliminated players
    const current = players.find((p) => p.id === playerId);
    submitVoteBtn.disabled = current && !current.alive;
    voteOptions.innerHTML = '';
    players.forEach((p) => {
      if (!p.alive) return; // no votar a eliminados
      const li = document.createElement('li');
      const label = document.createElement('label');
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'voteFor';
      radio.value = p.id;
      label.appendChild(radio);
      label.appendChild(document.createTextNode(p.name));
      li.appendChild(label);
      voteOptions.appendChild(li);
    });
    renderVotes();
  }

  /**
   * Muestra la lista de votos ya emitidos por todos los jugadores.
   * Como no se muestra quién votó a quién, simplemente se listan
   * entradas de «Alguien votó por <nombre>».
   */
  function renderVotes() {
    votesList.innerHTML = '';
    votes.forEach((v) => {
      const li = document.createElement('li');
      const player = players.find((p) => p.id === v.voteForId);
      li.textContent = `Se votó por ${player ? player.name : 'desconocido'}`;
      votesList.appendChild(li);
    });
  }

  /**
   * Comienza el intervalo de sondeo cada segundo.  Si ya existe un
   * intervalo activo lo limpia para no duplicar llamadas.  El sondeo
   * mantiene actualizada la interfaz en tiempo real.
   */
  function startPolling() {
    if (pollInterval) clearInterval(pollInterval);
    pollInterval = setInterval(pollRoom, 1000);
  }

  /**
   * Asocia los manejadores de eventos a los botones e inicia la
   * aplicación en la pantalla de creación.
   */
  function init() {
    createRoomBtn.addEventListener('click', createRoom);
    joinRoomBtn.addEventListener('click', joinRoom);
    // Confirm and force actions for starting the game
    startGameBtn.addEventListener('click', () => sendConfirmation('start'));
    forceStartBtn.addEventListener('click', () => forceAction('start'));
    // Clue and vote actions
    sendClueBtn.addEventListener('click', sendClue);
    goToVoteBtn.addEventListener('click', () => sendConfirmation('votePhase'));
    forceVoteBtn.addEventListener('click', () => forceAction('votePhase'));
    // Voting actions
    submitVoteBtn.addEventListener('click', submitVote);
    // Reemplazamos 'Ver resultados' por una acción comunitaria.  Cada jugador
    // confirma que quiere ver los resultados.  Cuando todos los jugadores
    // vivos confirman (o el anfitrión fuerza), el servidor calcula el
    // resultado de la votación y pasa a la pantalla de resultados.
    showResultsBtn.addEventListener('click', () => sendConfirmation('showResults'));
    // Votación: forzar resultados está disponible para el anfitrión
    forceResultsBtn.addEventListener('click', () => forceAction('showResults'));
    // Results actions (next clue or next round)
    nextActionBtn.addEventListener('click', () => {
      if (awaitingAction) {
        sendConfirmation(awaitingAction);
      }
    });
    forceNextBtn.addEventListener('click', () => {
      if (awaitingAction) {
        forceAction(awaitingAction);
      }
    });
    // Pantalla inicial
    showScreen('create');
    // Ocultar botón de nueva ronda/partida inicialmente
    newRoundBtn.style.display = 'none';
  }

  // Lanzar cuando el DOM esté listo
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();