FROM --platform=$BUILDPLATFORM node:22 AS build

WORKDIR /usr/local/apps/citrineos-ocpi

# COPY
COPY . .

# INSTALL
RUN npm run install-all

# BUILD citrineos-core workspace dependencies (excluded from root tsconfig, dist not in docker context)
RUN npx tsc --build ./citrineos-core/02_Util/tsconfig.json

# BUILD
RUN npm run build

# The final stage, which copies built files and prepares the run environment
# Using alpine image to reduce the final image size
FROM --platform=$BUILDPLATFORM node:22-alpine
COPY --from=build /usr/local/apps/citrineos-ocpi /usr/local/apps/citrineos-ocpi

WORKDIR /usr/local/apps/citrineos-ocpi

EXPOSE ${PORT}

CMD ["npm", "run", "start-docker-cloud"]
