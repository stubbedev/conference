// Package wav reads and writes 16-bit mono PCM WAV files.
package wav

import (
	"encoding/binary"
	"errors"
	"fmt"
	"math"
)

const (
	headerSize    = 44
	fmtChunkSize  = 16
	chunkHeader   = 8
	pcmFormat     = 1
	mono          = 1
	bitsPerSample = 16
	bytesPerFrame = bitsPerSample / 8
)

var (
	errNotWAV     = errors.New("wav: not a RIFF/WAVE file")
	errNotPCM16   = errors.New("wav: not 16-bit mono PCM")
	errNoData     = errors.New("wav: no data chunk")
	errTruncated  = errors.New("wav: chunk runs past the end of the file")
	errNoFmtChunk = errors.New("wav: no fmt chunk before the data chunk")
	errTooLong    = errors.New("wav: audio too long for a WAV file")
)

// Encode wraps 16-bit mono samples at rate Hz in a WAV file.
func Encode(pcm []int16, rate uint32) ([]byte, error) {
	dataSize := uint64(len(pcm)) * bytesPerFrame
	if dataSize > math.MaxUint32-headerSize || uint64(rate)*bytesPerFrame > math.MaxUint32 {
		return nil, fmt.Errorf("%w: %d samples at %d Hz", errTooLong, len(pcm), rate)
	}

	out := make([]byte, 0, headerSize+dataSize)
	out = append(out, "RIFF"...)
	out = binary.LittleEndian.AppendUint32(out, uint32(headerSize-chunkHeader+dataSize))
	out = append(out, "WAVEfmt "...)
	out = binary.LittleEndian.AppendUint32(out, fmtChunkSize)
	out = binary.LittleEndian.AppendUint16(out, pcmFormat)
	out = binary.LittleEndian.AppendUint16(out, mono)
	out = binary.LittleEndian.AppendUint32(out, rate)
	out = binary.LittleEndian.AppendUint32(out, rate*bytesPerFrame)
	out = binary.LittleEndian.AppendUint16(out, bytesPerFrame)
	out = binary.LittleEndian.AppendUint16(out, bitsPerSample)
	out = append(out, "data"...)
	out = binary.LittleEndian.AppendUint32(out, uint32(dataSize))

	out, err := binary.Append(out, binary.LittleEndian, pcm)
	if err != nil {
		return nil, fmt.Errorf("wav: encode samples: %w", err)
	}

	return out, nil
}

// Decode returns the samples and sample rate of a 16-bit mono PCM WAV file.
func Decode(data []byte) ([]int16, uint32, error) {
	if len(data) < 12 || string(data[0:4]) != "RIFF" || string(data[8:12]) != "WAVE" {
		return nil, 0, errNotWAV
	}

	var rate uint32

	for rest := data[12:]; len(rest) >= chunkHeader; {
		id, body, next, err := nextChunk(rest)
		if err != nil {
			return nil, 0, err
		}

		rest = next

		switch id {
		case "fmt ":
			rate, err = pcm16Rate(body)
			if err != nil {
				return nil, 0, err
			}
		case "data":
			if rate == 0 {
				return nil, 0, errNoFmtChunk
			}

			pcm, err := samples(body)

			return pcm, rate, err
		}
	}

	return nil, 0, errNoData
}

func samples(body []byte) ([]int16, error) {
	pcm := make([]int16, len(body)/bytesPerFrame)

	_, err := binary.Decode(body, binary.LittleEndian, pcm)
	if err != nil {
		return nil, fmt.Errorf("wav: decode samples: %w", err)
	}

	return pcm, nil
}

func nextChunk(data []byte) (string, []byte, []byte, error) {
	id := string(data[0:4])
	size := uint64(binary.LittleEndian.Uint32(data[4:8]))
	rest := data[chunkHeader:]

	if size > uint64(len(rest)) {
		return "", nil, nil, fmt.Errorf("%w: %q", errTruncated, id)
	}

	return id, rest[:size], rest[min(size+size%2, uint64(len(rest))):], nil
}

func pcm16Rate(format []byte) (uint32, error) {
	if len(format) < fmtChunkSize || binary.LittleEndian.Uint16(format[0:]) != pcmFormat ||
		binary.LittleEndian.Uint16(format[2:]) != mono || binary.LittleEndian.Uint16(format[14:]) != bitsPerSample {
		return 0, errNotPCM16
	}

	return binary.LittleEndian.Uint32(format[4:]), nil
}
