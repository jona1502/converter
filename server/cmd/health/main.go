// Healthcheck executable for minimal images without a shell or HTTP client.
package main

import (
	"flag"
	"net/http"
	"os"
	"time"
)

func main() {
	url := flag.String("url", "http://127.0.0.1:8000/api/v1/health/ready", "local health endpoint")
	flag.Parse()
	client := &http.Client{Timeout: 4 * time.Second}
	response, err := client.Get(*url)
	if err != nil {
		os.Exit(1)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusOK {
		os.Exit(1)
	}
}
