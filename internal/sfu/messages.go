package sfu

// MessageType names a signalling message on the websocket.
type MessageType string

const (
	msgWelcome               MessageType = "welcome"
	msgMemberJoined          MessageType = "member-joined"
	msgMemberLeft            MessageType = "member-left"
	msgMemberState           MessageType = "member-state"
	msgError                 MessageType = "error"
	msgRecording             MessageType = "recording"
	msgTranslating           MessageType = "translating"
	msgLayers                MessageType = "layers"
	msgLang                  MessageType = "lang"
	msgCaption               MessageType = "caption"
	msgChat                  MessageType = "chat"
	msgForced                MessageType = "forced"
	msgKicked                MessageType = "kicked"
	msgAnswer                MessageType = "answer"
	msgOffer                 MessageType = "offer"
	msgIce                   MessageType = "ice"
	msgTranslateToken        MessageType = "translate-token"
	msgJoin                  MessageType = "join"
	msgClose                 MessageType = "close"
	msgPli                   MessageType = "pli"
	msgState                 MessageType = "state"
	msgRecord                MessageType = "record"
	msgModerate              MessageType = "moderate"
	msgLayer                 MessageType = "layer"
	msgTranslate             MessageType = "translate"
	msgTranslateTokenRequest MessageType = "translate-token-request"
)
