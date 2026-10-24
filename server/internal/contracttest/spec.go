// Package contracttest prüft Go-Typen und echte Antworten gegen den Vertrag
// api/openapi.json. Der Validator deckt genau die dort verwendete Teilmenge
// von JSON Schema ab; ein unbekanntes Schlüsselwort ist ein Fehler, damit
// keine Einschränkung still ignoriert wird.
package contracttest

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// Schema ist ein JSON-Schema-Objekt aus der OpenAPI-Datei.
type Schema = map[string]any

// Spec ist die geladene OpenAPI-Datei.
type Spec struct {
	doc        map[string]any
	components map[string]any
}

// SpecPath sucht api/openapi.json vom Arbeitsverzeichnis aufwärts.
func SpecPath() (string, error) {
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for {
		p := filepath.Join(dir, "api", "openapi.json")
		if _, err := os.Stat(p); err == nil {
			return p, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", errors.New("api/openapi.json nicht gefunden")
		}
		dir = parent
	}
}

// Load liest eine OpenAPI-Datei.
func Load(path string) (*Spec, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var doc map[string]any
	if err := decodeNumbers(data, &doc); err != nil {
		return nil, err
	}
	comps, _ := doc["components"].(map[string]any)
	schemas, _ := comps["schemas"].(map[string]any)
	if schemas == nil {
		return nil, errors.New("components.schemas fehlt")
	}
	return &Spec{doc: doc, components: schemas}, nil
}

// MustLoad lädt den Vertrag für Tests.
func MustLoad(t testing.TB) *Spec {
	t.Helper()
	p, err := SpecPath()
	if err != nil {
		t.Fatal(err)
	}
	s, err := Load(p)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func decodeNumbers(data []byte, v any) error {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	if err := dec.Decode(v); err != nil {
		return err
	}
	if dec.More() {
		return errors.New("nachfolgende Daten")
	}
	return nil
}

// ComponentNames liefert alle Schemanamen.
func (s *Spec) ComponentNames() []string {
	names := make([]string, 0, len(s.components))
	for n := range s.components {
		names = append(names, n)
	}
	return names
}

// Component liefert ein Komponentenschema.
func (s *Spec) Component(name string) (Schema, bool) {
	c, ok := s.components[name].(map[string]any)
	return c, ok
}

// ResponseSchema liefert das JSON-Schema der Antwort einer Operation.
func (s *Spec) ResponseSchema(path, method string, status int) (Schema, error) {
	paths, _ := s.doc["paths"].(map[string]any)
	item, ok := paths[path].(map[string]any)
	if !ok {
		return nil, fmt.Errorf("Pfad %s fehlt im Vertrag", path)
	}
	op, ok := item[strings.ToLower(method)].(map[string]any)
	if !ok {
		return nil, fmt.Errorf("%s %s fehlt im Vertrag", method, path)
	}
	responses, _ := op["responses"].(map[string]any)
	resp, ok := responses[strconv.Itoa(status)].(map[string]any)
	if !ok {
		return nil, fmt.Errorf("%s %s: Status %d ist nicht dokumentiert", method, path, status)
	}
	content, _ := resp["content"].(map[string]any)
	media, ok := content["application/json"].(map[string]any)
	if !ok {
		return nil, fmt.Errorf("%s %s %d: kein application/json", method, path, status)
	}
	schema, _ := media["schema"].(map[string]any)
	return schema, nil
}

func (s *Spec) resolve(ref string) (Schema, string, error) {
	name, ok := strings.CutPrefix(ref, "#/components/schemas/")
	if !ok {
		return nil, "", fmt.Errorf("nicht unterstützte Referenz %q", ref)
	}
	c, ok := s.Component(name)
	if !ok {
		return nil, "", fmt.Errorf("Komponente %q fehlt", name)
	}
	return c, name, nil
}
