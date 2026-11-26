CXX      ?= c++
CXXFLAGS ?= -std=c++17 -O3 -DNDEBUG -Wall -Wextra -Wpedantic -Wshadow
DBGFLAGS  = -std=c++17 -O1 -g -Wall -Wextra -fsanitize=address,undefined -fno-omit-frame-pointer

SRC = src/cnf.cpp src/cdcl.cpp src/reference.cpp src/main.cpp
HDR = $(wildcard src/*.hpp)

.PHONY: all debug test fuzz bench clean

all: build/logiclab

build/logiclab: $(SRC) $(HDR)
	@mkdir -p build
	$(CXX) $(CXXFLAGS) -o $@ $(SRC)

build/logiclab-debug: $(SRC) $(HDR)
	@mkdir -p build
	$(CXX) $(DBGFLAGS) -o $@ $(SRC)

debug: build/logiclab-debug

test: build/logiclab
	python3 tests/run_tests.py

# Long fuzzing run against the sanitizer build.
fuzz: build/logiclab-debug
	python3 tests/run_tests.py --solver build/logiclab-debug --fuzz 3000

bench: build/logiclab
	python3 bench/bench.py

clean:
	rm -rf build bench/instances
