; Cadence-native simulation artifact export for virtuoso-agent.
; These functions run inside the existing managed Virtuoso process.

procedure(vaSimulationExportBoolean(value)
	if(value then "true" else "false")
)

procedure(vaSimulationExportEmitError(errorType message resultPath)
	vaSessionWriteResult(resultPath vaErrorEnvelope(errorType message))
)

procedure(vaSimulationExportCreateSchematicNetlist(library cell view)
	let((netlistPath)
		simulator('spectre)
		design(library cell view)
		netlistPath = createNetlist(?recreateAll t ?display nil)
		when(isCallable('ocnCloseSession)
			ocnCloseSession()
		)
		netlistPath
	)
)

procedure(vaSessionExportSchematicNetlist(library cell view resultPath)
	let((captured netlistPath data)
		captured = errset(vaSimulationExportCreateSchematicNetlist(library cell view) t)
		if(captured && car(captured) then
			netlistPath = car(captured)
			data = sprintf(
				nil
				"{\"path\":%s,\"virtuosoVersion\":%s}"
				vaJsonString(netlistPath)
				vaJsonString(getVersion(t))
			)
			vaSessionWriteResult(resultPath vaOkEnvelope(data))
		else
			vaSimulationExportEmitError(
				"SCHEMATIC_NETLIST_EXPORT_FAILED"
				sprintf(nil "Could not create a Spectre netlist for %s/%s/%s." library cell view)
				resultPath
			)
		)
	)
)

procedure(vaSimulationExportWriteSingleOceanScript(path testSession)
	let((filePointer result)
		when(isFile(path)
			deleteFile(path)
		)
		filePointer = asiOpenOceanScript(path)
		unless(filePointer
			error("Could not open OCEAN script %s.\n" path)
		)
		result = asiWriteOceanScript(filePointer testSession)
		asiCloseOceanScript(filePointer)
		unless(result
			error("Could not write OCEAN script %s.\n" path)
		)
		t
	)
)

procedure(vaSimulationExportRestoreEnabledTests(session enabledTests)
	maeEnableTests(?all t ?enable nil ?session session)
	when(enabledTests
		maeEnableTests(?testNames enabledTests ?enable t ?session session)
	)
)

procedure(vaSimulationExportWriteTestSweepOceanScript(path library cell view session testName enabledTests)
	let((result)
		when(isFile(path)
			deleteFile(path)
		)
		unwindProtect(
			progn(
				maeEnableTests(?all t ?enable nil ?session session)
				maeEnableTests(?testNames list(testName) ?enable t ?session session)
				result = axlWriteOceanScriptLCV(path library cell view)
				unless(result
					error("Could not write sweep OCEAN script %s for test %s.\n" path testName)
				)
			)
			vaSimulationExportRestoreEnabledTests(session enabledTests)
		)
		t
	)
)

procedure(vaSimulationExportPrepareMaestro(library cell view bundleDir scope requestedTestName)
	let((
		existingSessions session closeSession tests enabledTests enabledStateCaptured topOceanPath topResult
		includeTop includeTests testItems separator index testName exportTest testSession
		testDir singlePath sweepPath enabled topOceanJson
		designLibrary designCell designView netlistResult netlistDir simInputFile netlistPath
	)
		unless(member(scope list("all" "top" "tests" "test"))
			error("Unsupported Maestro export scope: %s.\n" scope)
		)
		when(scope == "test" && requestedTestName == ""
			error("A test name is required for Maestro export scope test.\n")
		)
		includeTop = member(scope list("all" "top"))
		includeTests = member(scope list("all" "tests" "test"))
		existingSessions = maeGetSessions()
		session = maeOpenSetup(
			library
			cell
			view
			?mode "r"
			?application "Assembler"
		)
		unless(session
			error("Could not open Maestro setup %s/%s/%s.\n" library cell view)
		)
		closeSession = not(member(session existingSessions))
		unless(maeIsValidMaestroSession(session)
			error("Invalid Maestro setup %s/%s/%s.\n" library cell view)
		)

		unwindProtect(
			progn(
				tests = maeGetSetup(?typeName "tests" ?enabled 'all ?session session)
				when(includeTests
					enabledTests = maeGetSetup(?typeName "tests" ?enabled t ?session session)
					enabledStateCaptured = t
				)
				when(scope == "test" && not(member(requestedTestName tests))
					error("Could not find Maestro test %s.\n" requestedTestName)
				)
				when(includeTop
					topOceanPath = strcat(bundleDir "/maestro/maestro.ocn")
					topResult = axlWriteOceanScriptLCV(topOceanPath library cell view)
					unless(topResult
						error("Could not export top-level Maestro OCEAN script.\n")
					)
				)

				testItems = ""
				separator = ""
				index = 0
				foreach(testName tests
					index = index + 1
					exportTest = includeTests && (scope != "test" || testName == requestedTestName)
					when(exportTest
						testDir = sprintf(nil "%s/tests/%03d" bundleDir index)
						unless(isDir(testDir)
							createDir(testDir)
						)
						singlePath = strcat(testDir "/single.ocn")
						sweepPath = strcat(testDir "/sweep.ocn")
						testSession = maeGetTestSession(testName ?session session)
						unless(testSession
							error("Could not get test session for %s.\n" testName)
						)

						designLibrary = asiGetDesignLibName(testSession)
						designCell = asiGetDesignCellName(testSession)
						designView = asiGetDesignViewName(testSession)
						unless(designLibrary && designCell && designView
							error("Could not resolve the design for test %s.\n" testName)
						)

						vaSimulationExportWriteSingleOceanScript(singlePath testSession)
						vaSimulationExportWriteTestSweepOceanScript(
							sweepPath library cell view session testName enabledTests
						)
						netlistResult = asiNetlist(testSession)
						unless(netlistResult
							error("Could not netlist Maestro test %s.\n" testName)
						)
						netlistDir = asiGetNetlistDir(testSession)
						simInputFile = asiGetSimInputFileName(testSession)
						unless(netlistDir && simInputFile
							error("Could not resolve the generated netlist for test %s.\n" testName)
						)
						netlistPath = strcat(netlistDir "/" simInputFile)
						unless(isFile(netlistPath)
							error("Generated netlist does not exist for test %s: %s.\n" testName netlistPath)
						)

						enabled = if(member(testName enabledTests) then t else nil)
						testItems = strcat(
							testItems
							separator
							sprintf(
								nil
								"{\"index\":%L,\"name\":%s,\"enabled\":%s,\"singleOceanPath\":%s,\"sweepOceanPath\":%s,\"netlistPath\":%s,\"design\":{\"library\":%s,\"cell\":%s,\"view\":%s}}"
								index
								vaJsonString(testName)
								vaSimulationExportBoolean(enabled)
								vaJsonString(singlePath)
								vaJsonString(sweepPath)
								vaJsonString(netlistPath)
								vaJsonString(designLibrary)
								vaJsonString(designCell)
								vaJsonString(designView)
							)
						)
						separator = ","
					)
				)
				topOceanJson = if(topOceanPath then vaJsonString(topOceanPath) else "null")
				sprintf(
					nil
					"{\"scope\":%s,\"topOceanPath\":%s,\"virtuosoVersion\":%s,\"tests\":[%s]}"
					vaJsonString(scope)
					topOceanJson
					vaJsonString(getVersion(t))
					testItems
				)
			)
			progn(
				when(enabledStateCaptured
					vaSimulationExportRestoreEnabledTests(session enabledTests)
				)
				when(closeSession
					maeCloseSession(?session session ?simulation "continue")
				)
			)
		)
	)
)

procedure(vaSessionPrepareMaestroExportV4(library cell view bundleDir scope requestedTestName resultPath)
	let((captured)
		captured = errset(
			vaSimulationExportPrepareMaestro(library cell view bundleDir scope requestedTestName)
			t
		)
		if(captured && car(captured) then
			vaSessionWriteResult(resultPath vaOkEnvelope(car(captured)))
		else
			vaSimulationExportEmitError(
				"MAESTRO_EXPORT_PREPARE_FAILED"
				sprintf(nil "Could not export Maestro setup %s/%s/%s." library cell view)
				resultPath
			)
		)
	)
)
