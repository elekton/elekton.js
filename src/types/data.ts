export interface UserData {
    name: string
    surname: string
}

export interface BallotData {
    name: string
    description: string
    proposals: string[]
    voters: string[]
    smtRoot: string
    startDate: number
    endDate: number
    votes: number[]
    decryptionKey: string
}
