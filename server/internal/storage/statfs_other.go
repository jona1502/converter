//go:build !linux

package storage

import "errors"

func freeBytes(string) (uint64, error) { return 0, errors.ErrUnsupported }
