import { User } from "./User"
import { eddsa, poseidon } from "circomlib"
import createBlakeHash from "blake-hash"
import { Scalar, utils } from "ffjavascript"
import { BigNumber, Contract, Wallet } from "ethers"
import { BallotData, ElektonConfig } from "./types"
import { createSparseMerkleTree, unpackVoterPublicKey, hexToBuffer, getProofParameters } from "./utils"

export class Ballot {
    private config: ElektonConfig
    private contract: Contract

    index: number
    ipfsCid: string

    adminAddress: string // Ethereum address.
    name: string
    description: string
    proposals: string[]
    voterPublicKeys: string[]
    startDate: number
    endDate: number

    constructor(ballotData: BallotData) {
        this.config = ballotData.config
        this.contract = ballotData.contract

        this.index = ballotData.index
        this.ipfsCid = ballotData.ipfsCid

        this.adminAddress = ballotData.adminAddress
        this.name = ballotData.name
        this.description = ballotData.description
        this.proposals = ballotData.proposals
        this.voterPublicKeys = ballotData.voterPublicKeys
        this.startDate = ballotData.startDate
        this.endDate = ballotData.endDate
    }

    async vote(user: User, vote: number): Promise<void | null> {
        if (!user.voterPrivateKey) {
            return null
        }

        const blakeHash = createBlakeHash("blake512").update(hexToBuffer(user.voterPrivateKey)).digest()
        const sBuff = eddsa.pruneBuffer(blakeHash.slice(0, 32))
        const s = utils.leBuff2int(sBuff)
        const ppk = Scalar.shr(s, 3)

        const signature = eddsa.signPoseidon(hexToBuffer(user.voterPrivateKey), BigInt(vote))
        const voteNullifier = poseidon([this.index, ppk])

        const tree = createSparseMerkleTree(this.voterPublicKeys)
        const { sidenodes } = tree.createProof(unpackVoterPublicKey(user.voterPublicKey)[0])

        while (sidenodes.length < 10) {
            sidenodes.push(BigInt(0))
        }

        const proofParameters = await getProofParameters(
            {
                privateKey: ppk,
                R8x: signature.R8[0],
                R8y: signature.R8[1],
                S: signature.S,
                smtSiblings: sidenodes,
                smtRoot: tree.root,
                vote: BigInt(vote),
                ballotIndex: this.index,
                voteNullifier
            },
            this.config.wasmFilePath,
            this.config.zkeyFilePath
        )

        const transaction = await this.contract.vote(...proofParameters)

        await transaction.wait()
    }

    async publishDecryptionKey(user: User, decryptionKey: number): Promise<void> {
        const wallet = new Wallet(user.privateKey as string, this.contract.provider)
        const transaction = await this.contract.connect(wallet).publishDecryptionKey(this.index, decryptionKey)

        await transaction.wait()
    }

    async retrieveVotes(last = Infinity): Promise<number[]> {
        const filter = this.contract.filters.VoteAdded(this.index)
        const voteEvents = await this.contract.queryFilter(filter)
        const votes: number[] = []

        if (voteEvents.length < last) {
            last = voteEvents.length
        }

        for (let i = voteEvents.length - 1; i >= voteEvents.length - last; i--) {
            const eventArgs = voteEvents[i].args as any

            votes.push(eventArgs._vote.toNumber())
        }

        return votes
    }

    onVoteAdded(listener: (vote: number, ballotIndex: number) => void): () => void {
        const filter = this.contract.filters.VoteAdded(this.index)
        const retrieveVote = (ballotIndex: BigNumber, vote: BigNumber) => {
            listener(vote.toNumber(), ballotIndex.toNumber())
        }

        this.contract.on(filter, retrieveVote)

        return this.contract.off.bind(this.contract, filter, retrieveVote)
    }

    onDecryptionKeyPublished(listener: (decryptionKey: number, ballotIndex: number) => void): () => void {
        const filter = this.contract.filters.DecryptionKeyPublished(this.index)
        const retrieveVote = (ballotIndex: BigNumber, decryptionKey: BigNumber) => {
            listener(decryptionKey.toNumber(), ballotIndex.toNumber())
        }

        this.contract.on(filter, retrieveVote)

        return this.contract.off.bind(this.contract, filter, retrieveVote)
    }
}
