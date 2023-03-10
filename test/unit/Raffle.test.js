const { assert, expect } = require("chai")
const { getNamedAccounts, deployments, ethers, getChainId, network } = require("hardhat")
const { developmentChains } = require("../../helper-hardhat-config")
const { networkConfig } = require("../../helper-hardhat-config")

if (!developmentChains.includes(network.name)) {
    describe.skip
} else {
    describe("Raffle Unit Tests", function () {
        let raffle, vrfCoordinatorV2Mock, raffleEntranceFee, deployer, interval
        const chainId = network.config.chainId

        beforeEach(async function () {
            deployer = (await getNamedAccounts()).deployer
            await deployments.fixture(["all"]) // Deploy setup fixture (hardhat-deploy)
            raffle = await ethers.getContract("Raffle", deployer)
            vrfCoordinatorV2Mock = await ethers.getContract("VRFCoordinatorV2Mock", deployer)
            raffleEntranceFee = await raffle.getEntranceFee()
            interval = await raffle.getInterval()
        })

        describe("constructor", function () {
            it("Initialises Raffle contract correctly", async function () {
                const raffleState = await raffle.getRaffleState()
                assert.equal(raffleState.toString(), "0")
                assert.equal(interval.toString(), networkConfig[chainId]["interval"])
            })
        })

        describe("enterRaffle", function () {
            it("Reverts when payment insufficient", async function () {
                await expect(raffle.enterRaffle()).to.be.revertedWith("Raffle__NotEnoughETHEntered")
            })
            it("Records players when they enter", async function () {
                await raffle.enterRaffle({ value: raffleEntranceFee })
                const playerFromContract = await raffle.getPlayer(0)
                assert.equal(playerFromContract, deployer)
            })
            it("Emits event on raffle entrance", async function () {
                await expect(raffle.enterRaffle({ value: raffleEntranceFee })).to.emit(
                    raffle,
                    "RaffleEnter"
                )
            })
            it("Does not allow entrance when raffle is calculating", async function () {
                await raffle.enterRaffle({ value: raffleEntranceFee })
                await network.provider.send("evm_increaseTime", [interval.toNumber() + 1]) // Force time forward to trigger upkeep
                await network.provider.request({ method: "evm_mine", params: [] })

                // Pretend to be a Chainlink Keeper and force upkeep to be performed
                await raffle.performUpkeep([])
                await expect(raffle.enterRaffle({ value: raffleEntranceFee })).to.be.revertedWith(
                    "Raffle__NotOpen"
                )
            })
        })

        describe("checkUpkeep", function () {
            it("Returns false if people haven't sent any ETH", async function () {
                await network.provider.send("evm_increaseTime", [interval.toNumber() + 1])
                await network.provider.request({ method: "evm_mine", params: [] })
                const { upkeepNeeded } = await raffle.callStatic.checkUpkeep([]) // callStatic asks node to pretend a transaction does not change the blockchain state and return the result
                assert(!upkeepNeeded)
            })
            it("Returns false if Raffle is in calculating state", async function () {
                await raffle.enterRaffle({ value: raffleEntranceFee })
                await network.provider.send("evm_increaseTime", [interval.toNumber() + 1])
                await network.provider.request({ method: "evm_mine", params: [] })
                await raffle.performUpkeep("0x") // blank bytes objects can be represented as [] or "0x"
                const raffleState = await raffle.getRaffleState()
                const { upkeepNeeded } = await raffle.callStatic.checkUpkeep([])
                assert.equal(raffleState.toString(), "1") // "CALCULATING" from enum RaffleState
                assert.equal(upkeepNeeded, false)
            })
            it("returns false if enough time hasn't passed", async () => {
                await raffle.enterRaffle({ value: raffleEntranceFee })
                await network.provider.send("evm_increaseTime", [interval.toNumber() - 5])
                await network.provider.request({ method: "evm_mine", params: [] })
                const { upkeepNeeded } = await raffle.callStatic.checkUpkeep("0x")
                assert(!upkeepNeeded)
            })
            it("returns true if enough time has passed, has players, eth, and is open", async () => {
                await raffle.enterRaffle({ value: raffleEntranceFee })
                await network.provider.send("evm_increaseTime", [interval.toNumber() + 1])
                await network.provider.request({ method: "evm_mine", params: [] })
                const { upkeepNeeded } = await raffle.callStatic.checkUpkeep("0x")
                assert(upkeepNeeded)
            })
        })

        describe("performUpkeep", function () {
            it("It can only run if checkUpkeep is true", async function () {
                await raffle.enterRaffle({ value: raffleEntranceFee })
                await network.provider.send("evm_increaseTime", [interval.toNumber() + 1])
                await network.provider.request({ method: "evm_mine", params: [] })
                const tx = await raffle.performUpkeep("0x")
                assert(tx)
            })
            it("Reverts when checkUpkeep is false", async function () {
                await expect(raffle.performUpkeep([])).to.be.revertedWith("Raffle__UpkeepNotNeeded")
            })
            it("Updates the raffle state, emits an event, and calls the VRF Coordinator", async function () {
                await raffle.enterRaffle({ value: raffleEntranceFee })
                await network.provider.send("evm_increaseTime", [interval.toNumber() + 1])
                await network.provider.request({ method: "evm_mine", params: [] })
                const txResponse = await raffle.performUpkeep([])
                const txReceipt = await txResponse.wait(1)
                const requestId = txReceipt.events[1].args.requestId // 0th event is emitted by VRF Coordinator
                const raffleState = await raffle.getRaffleState()
                assert(requestId.toNumber() > 0)
                assert(raffleState.toString() == "1")
            })
        })

        describe("fulfillRandomWords", function () {
            beforeEach(async function () {
                await raffle.enterRaffle({ value: raffleEntranceFee })
                await network.provider.send("evm_increaseTime", [interval.toNumber() + 1])
                await network.provider.send("evm_mine", [])
            })

            it("It can only be called after performUpkeep", async function () {
                await expect(
                    vrfCoordinatorV2Mock.fulfillRandomWords(0, raffle.address)
                ).to.be.revertedWith("nonexistent request")
                await expect(
                    vrfCoordinatorV2Mock.fulfillRandomWords(1, raffle.address)
                ).to.be.revertedWith("nonexistent request")
            })
            it("Picks a winner, resets the lottery, and sends the money", async function () {
                const additionalEntrants = 3
                const startingAccountIndex = 1 // deployer = 0
                const accounts = await ethers.getSigners()
                for (
                    let i = startingAccountIndex;
                    i < startingAccountIndex + additionalEntrants;
                    i++
                ) {
                    const accountConnectedRaffle = raffle.connect(accounts[i])
                    await accountConnectedRaffle.enterRaffle({ value: raffleEntranceFee })
                }
                const startingTimeStamp = await raffle.getLatestTimeStamp()

                // performUpkeep (mock being Chainlink Keepers
                // fulfillRandomWords (mock being the Chainlink VRF)
                // We will have to wait for the fulfillRandomWords to be called

                await new Promise(async (resolve, reject) => {
                    raffle.once("WinnerPicked", async () => {
                        console.log("Found the event!")
                        try {
                            const recentWinner = await raffle.getRecentWinner()
                            // console.log(accounts[0].address)
                            // console.log(accounts[1].address)
                            // console.log(accounts[2].address)
                            // console.log(accounts[3].address)
                            // console.log(recentWinner)
                            const raffleState = await raffle.getRaffleState()
                            const endingTimeStamp = await raffle.getLatestTimeStamp()
                            const numPlayers = await raffle.getNumPlayers()
                            const winnerEndingBalance = await accounts[1].getBalance()
                            assert.equal(numPlayers.toString(), "0")
                            assert.equal(raffleState.toString(), "0")
                            assert(endingTimeStamp > startingTimeStamp)

                            assert.equal(
                                winnerEndingBalance.toString(),
                                winnerStartingBalance.add(
                                    raffleEntranceFee
                                        .mul(additionalEntrants)
                                        .add(raffleEntranceFee)
                                        .toString()
                                )
                            )
                        } catch (e) {
                            reject(e)
                        }
                        resolve()
                    })
                    // Setting up the listener
                    // below, we will fire the event, and the listener will pick it up, and resolve
                    const tx = await raffle.performUpkeep([])
                    const txReceipt = await tx.wait(1)
                    const winnerStartingBalance = await accounts[1].getBalance()
                    await vrfCoordinatorV2Mock.fulfillRandomWords(
                        txReceipt.events[1].args.requestId,
                        raffle.address
                    )
                })
            })
        })
    })
}
