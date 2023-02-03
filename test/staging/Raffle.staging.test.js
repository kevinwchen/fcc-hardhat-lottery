const { assert, expect } = require("chai")
const { getNamedAccounts, deployments, ethers, getChainId, network } = require("hardhat")
const { developmentChains } = require("../../helper-hardhat-config")

if (developmentChains.includes(network.name)) {
    describe.skip
} else {
    describe("Raffle Unit Tests", function () {
        let raffle, raffleEntranceFee, deployer

        beforeEach(async function () {
            deployer = (await getNamedAccounts()).deployer
            raffle = await ethers.getContract("Raffle", deployer)
            raffleEntranceFee = await raffle.getEntranceFee()
        })

        describe("fulfillRandomWords", function () {
            it("Works with live Chainlink Keepers and Chainlink VRF, we get a random winner", async function () {
                // Enter the raffle
                const startingTimeStamp = await raffle.getLatestTimeStamp()
                const accounts = await ethers.getSigners()

                console.log("Setting up listener")
                await new Promise(async function (resolve, reject) {
                    // Setup listener before we enter the raffle
                    // Just in case the blockchain moves faster than our code
                    raffle.once("WinnerPicked", async function () {
                        console.log("WinnerPicked event fired!")
                        try {
                            // Asserts
                            const recentWinner = await raffle.getRecentWinner()
                            const raffleState = await raffle.getRaffleState()
                            const winnerEndingBalance = await accounts[0].getBalance()
                            const endingTimeStamp = await raffle.getLatestTimeStamp()

                            // Check players array has been reset
                            await expect(raffle.getPlayer(0)).to.be.reverted
                            // Check the only entrant was the winner
                            assert.equal(recentWinner.toString(), accounts[0].address)
                            // Check the raffle is back in the open state
                            assert.equal(raffleState, 0)
                            // Check winner has been returned their entrance fee
                            assert.equal(
                                winnerEndingBalance.toString(),
                                winnerStartingBalance.add(raffleEntranceFee).toString()
                            )
                            assert(endingTimeStamp > startingTimeStamp)
                            resolve()
                        } catch (e) {
                            console.log(e)
                            reject(e)
                        }
                    })

                    //  Then entering the raffle
                    const tx = await raffle.enterRaffle({ value: raffleEntranceFee })
                    await tx.wait(1)
                    console.log("Entering raffle...")
                    const winnerStartingBalance = await accounts[0].getBalance
                })
            })
        })
    })
}
