# CPU by default; for an NVIDIA GPU build with
#   --build-arg BASE=nvidia/cuda:12.6.3-cudnn-runtime-ubuntu24.04
# The local voice engine, Piper, is GPL-3.0 and installed separately;
# --build-arg WITH_PIPER=false leaves it out (then use an
# openai-compatible VOICE_PROVIDER).
ARG BASE=ubuntu:24.04
FROM ${BASE}
ARG WITH_PIPER=true

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /srv
RUN python3 -m venv /venv
ENV PATH=/venv/bin:$PATH
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY languages.yaml .
RUN if [ "$WITH_PIPER" = true ]; then \
      pip install --no-cache-dir piper-tts==1.8.0 \
      && python -m piper.download_voices --data-dir /srv/voices \
        $(python -c "import yaml; print(' '.join(v for l in yaml.safe_load(open('languages.yaml'))['languages'].values() for v in l['voices'].values()))"); \
    fi

COPY app ./app

# No writable state besides the model cache volume: audio and text stay in memory.
ENV VOICES_DIR=/srv/voices HF_HOME=/models PORT=8090
EXPOSE 8090
CMD ["python", "-m", "app"]
