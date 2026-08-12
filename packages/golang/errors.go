package configdiscovery

import (
	"errors"
	"fmt"
)

// Kind is the closed list of SPEC section 5 error kinds. Callers switch on it; nothing should
// ever match on message text, which differs per parser and per language.
type Kind string

const (
	// KindNotFound names the condition where no recognized file exists anywhere. It is not an
	// error: Load returns defaults with Found false. The constant exists so a caller can name it.
	KindNotFound Kind = "not-found"
	// KindUnreadable is a file that exists but cannot be read.
	KindUnreadable Kind = "unreadable"
	// KindMalformed is a file the parser rejected.
	KindMalformed Kind = "malformed"
	// KindDuplicateFormat is config.yaml beside config.yml in one directory.
	KindDuplicateFormat Kind = "duplicate-format"
	// KindUnknownKey is a key the caller's schema does not declare.
	KindUnknownKey Kind = "unknown-key"
	// KindValidation is a value that failed the caller's schema.
	KindValidation Kind = "validation"
)

// ConfigError is every failure this package reports.
type ConfigError struct {
	Kind    Kind
	Path    string
	Line    int
	Column  int
	KeyPath string
	Message string
	Err     error
}

func (e *ConfigError) Error() string {
	message := e.Message
	if message == "" && e.Err != nil {
		message = e.Err.Error()
	}
	switch {
	case e.Path != "" && e.Line > 0:
		return fmt.Sprintf("%s: %s:%d: %s", e.Kind, e.Path, e.Line, message)
	case e.Path != "":
		return fmt.Sprintf("%s: %s: %s", e.Kind, e.Path, message)
	case e.KeyPath != "":
		return fmt.Sprintf("%s: %s: %s", e.Kind, e.KeyPath, message)
	default:
		return fmt.Sprintf("%s: %s", e.Kind, message)
	}
}

// Unwrap exposes the underlying parser error, so errors.Is reaches it.
func (e *ConfigError) Unwrap() error { return e.Err }

// IsKind reports whether err is (or wraps) a *ConfigError of kind k.
func IsKind(err error, k Kind) bool {
	var configError *ConfigError
	return errors.As(err, &configError) && configError.Kind == k
}
