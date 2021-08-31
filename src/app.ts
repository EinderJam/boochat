import type { PrismaClient, Team, User } from '@prisma/client'
import type { ValidateFunction } from 'ajv'
import type { JTDDataType } from 'ajv/dist/core'
import type { Server } from 'socket.io'
import cors from 'cors'
import express, { Express, json } from 'express'
import { nanoid } from 'nanoid'
import { GetRequest, PostRequest, Response, schemas } from './api'
import {
  ClientToServerEvents,
  ServerEvent,
  ServerToClientEvents,
} from './socket-api'
export interface AppAttributes {
  readonly io: Server<ClientToServerEvents, ServerToClientEvents>
  readonly validate: {
    [k in keyof typeof schemas]: ValidateFunction<
      JTDDataType<typeof schemas[k]>
    >
  }

  readonly prisma: PrismaClient
}

export class App implements AppAttributes {
  readonly io
  readonly validate
  readonly prisma
  readonly api: Express

  users: Map<number, User & { team: Team }>
  teams: Team[] = []
  tokens: Map<string, number>
  subapps: CreateSubApp[] = []

  constructor({ io, validate, prisma }: AppAttributes) {
    this.api = express()
    this.io = io
    this.validate = validate
    this.prisma = prisma

    void prisma.team.findMany().then((teams) => {
      this.teams = teams
    })

    this.users = new Map()
    this.tokens = new Map()

    this.io.on('connect', (socket) => {
      if (!socket.user) socket.emit(ServerEvent.LoggedOut)
      io.emit(ServerEvent.Stats, this.computeStats())
      socket.on('disconnect', () => {
        io.emit(ServerEvent.Stats, this.computeStats())
      })
    })

    this.api.use(json(), cors(), (req, _res, next) => {
      const { authorization: auth } = req.headers

      if (auth?.startsWith('Token ')) {
        const token = auth.slice(6)
        if (this.tokens.has(token))
          req.user = this.users.get(this.tokens.get(token) ?? -1)
      }

      next()
    })

    this.get(GetRequest.Teams, () => this.teams)
    this.get(GetRequest.UsersOnline, () => this.computeStats())

    this.post(PostRequest.Login, async ({ login, teamId }) => {
      const team = this.teams.find(({ id }) => id === teamId)

      if (!team) throw new Error("Cette équipe n'existe pas")

      const user = await prisma.user.upsert({
        create: { name: login, teamId },
        update: { teamId },
        where: { name: login },
        include: { team: true },
      })

      const token = nanoid()
      this.users.set(user.id, user)
      this.tokens.set(token, user.id)

      return { token }
    })

    this.post(PostRequest.Token, ({ token }) => this.tokens.has(token))

    io.use((socket, next) => {
      const { token } = socket.handshake.auth
      socket.user = this.users.get(this.tokens.get(token) ?? -1)
      next()
    })
  }

  post<T extends PostRequest>(
    path: T,
    handler: (
      body: JTDDataType<typeof schemas[T]>
    ) => Response[T] | Promise<Response[T]>
  ): void {
    this.api.post(path, async (req, res) => {
      if (!('body' in req) || !this.validate[path](req.body)) {
        res.status(400).json({ error: 'Invalid data' })
      } else {
        try {
          res.json(await handler(req.body as JTDDataType<typeof schemas[T]>))
        } catch (error: unknown) {
          console.error(error)
          res.status(400).json({
            error: error instanceof Error ? error.message : 'Bad Request',
          })
        }
      }
    })
  }

  get<T extends GetRequest>(
    path: T,
    handler: () => Response[T] | Promise<Response[T]>
  ): void {
    this.api.get(path, async (_req, res) => {
      res.json(await handler())
    })
  }

  use(...subapps: CreateSubApp[]): void {
    this.subapps = [...this.subapps, ...subapps]
    for (const subapp of subapps) subapp(this)
  }

  computeStats(): {
    online: number
    connected: number
    users: Array<{
      user: User & {
        team: Team
      }
      online: number
    }>
  } {
    let online = 0
    let connected = 0
    const users = new Map<User & { team: Team }, number>()

    for (const socket of this.io.sockets.sockets.values()) {
      online++
      if (!socket.user) continue
      connected++
      users.set(socket.user, (users.get(socket.user) ?? 0) + 1)
    }

    return {
      online,
      connected,
      users: [...users.entries()].map(([user, online]) => ({ user, online })),
    }
  }
}

export type CreateSubApp = (app: App) => void
